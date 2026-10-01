/* =========================================================
 * TANK 1998 · 双人合作 —— 浏览器端 WebSocket 封装（零依赖）
 * 只做传输层：连接 /ws、创建或加入房间、输入与快照中继、断线自动重连。
 * 由 game.js 的 coopInit 调度；游戏逻辑始终只在房主端运行。
 *
 * 断线重连：连接意外断开时按指数退避重试，并用房间号 + 令牌
 * （room.rejoin）抢回原角色；主动 disconnect() 不触发重连。
 * ========================================================= */
(function (global) {
  'use strict';

  // 指数退避：总重试窗口约 13.5s，需小于服务端 RECONNECT_WINDOW
  const RETRY_DELAYS = [500, 1000, 2000, 4000, 6000];
  const RELAY_KEY = 'tank1998_relay';

  /* 从 location.search 取 relay 参数（不依赖 URLSearchParams：
   * 老环境与无头测试沙箱里它未必存在） */
  function queryRelay(){
    try {
      const s = String((location && location.search) || '');
      if (s.length < 2) return '';
      const body = s.charAt(0) === '?' ? s.slice(1) : s;
      const parts = body.split('&');
      for (let i = 0; i < parts.length; i++){
        const eq = parts[i].indexOf('=');
        const k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
        if (k !== 'relay') continue;
        const v = eq < 0 ? '' : parts[i].slice(eq + 1);
        try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { return v; }
      }
    } catch (e) {}
    return '';
  }

  /* 规范化中继地址（手写解析，不依赖 URL 构造器）：
   *   'relay.example.com:9000'   -> https 页面下补成 'wss://relay.example.com:9000/ws'
   *   '192.168.1.7:8080'         -> http 页面下补成 'ws://192.168.1.7:8080/ws'
   *   'wss://x/ws' / 'ws://x/a'  -> 保留原协议与路径
   * 非 ws/wss 协议（http/https/其他）或无主机名 -> 返回 ''，由调用方回退同源。 */
  const RELAY_RE = /^(wss?):\/\/([^/?#]+)([^?#]*)/i;
  function normalizeRelay(raw){
    let s = String(raw || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)){
      const secure = (typeof location !== 'undefined' && location && location.protocol === 'https:');
      s = (secure ? 'wss://' : 'ws://') + s;
    }
    const m = RELAY_RE.exec(s);
    if (!m) return '';
    let p = m[3] || '';
    if (p === '' || p === '/') p = '/ws';
    if (p.charAt(0) !== '/') p = '/' + p;
    return m[1].toLowerCase() + '://' + m[2] + p;
  }

  /* 优先 ?relay= 查询参数，其次 localStorage 里记住的地址 */
  function relayOverride(){
    const q = queryRelay();
    if (q){ const u = normalizeRelay(q); if (u) return u; }
    try {
      const v = localStorage.getItem(RELAY_KEY);
      if (v){ const u = normalizeRelay(v); if (u) return u; }
    } catch (e) {}
    return '';
  }

  const Net = {
    _ws: null,
    _openCb: null,
    _msgCb: null,
    _mode: 'off',
    _code: '',
    _token: '',
    _intentional: false,
    _reconnecting: false,
    _attempt: 0,
    _retryTimer: null,

    /* mode: 'host' | 'guest'；guest 需传 code（房间号） */
    connect(mode, code) {
      this._mode = mode || 'off';
      this._code = code || '';
      this._token = '';
      this._intentional = false;
      this._reconnecting = false;
      this._attempt = 0;
      this._clearTimer();
      this._open();
    },

    /* 中继地址：默认同源 /ws。页面托管在静态站点、而游戏服务在另一台机器时，
     * 用 ?relay=wss://host:port/ws 或面板里填的地址指向独立中继。 */
    _url() {
      const override = relayOverride();
      if (override) return override;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proto + '//' + location.host + '/ws';
    },

    _emit(msg) { if (this._msgCb) this._msgCb(msg); },

    _open() {
      let ws;
      try { ws = new WebSocket(this._url()); }
      catch (e) { this._emit({ type: 'error', code: 'WS_CREATE_FAIL' }); this._giveUp(); return; }
      this._ws = ws;

      ws.onopen = () => {
        if (this._reconnecting && this._token) {
          // 重连：请求恢复原角色（服务端凭令牌放行）
          this._send({ type: 'room', action: 'rejoin', code: this._code, token: this._token });
        } else if (this._openCb) {
          this._openCb();
        }
      };

      ws.onmessage = (ev) => {
        let m = null;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m || typeof m !== 'object') return;
        if (m.type === 'room' && m.code) this._code = m.code;      // 房主在 created 后才拿到房间号
        if (m.type === 'room' && m.token) this._token = m.token;   // 记住令牌以便重连
        if (m.type === 'room' && m.action === 'rejoined') {
          this._reconnecting = false;
          this._attempt = 0;
          this._emit({ type: 'net', event: 'reconnected', role: m.role });
          return;
        }
        if (this._reconnecting && m.type === 'error' &&
            (m.code === 'REJOIN_FAILED' || m.code === 'ROOM_NOT_FOUND')) {
          this._giveUp();
          return;
        }
        this._emit(m);
      };

      ws.onclose = () => {
        this._ws = null;
        if (this._intentional || this._mode === 'off') return;
        this._emit({ type: 'net', event: 'offline' });
        this._scheduleReconnect();
      };

      ws.onerror = () => { /* onclose 会随后触发，统一在那里处理 */ };
    },

    _scheduleReconnect() {
      if (this._reconnecting && this._attempt >= RETRY_DELAYS.length) { this._giveUp(); return; }
      const delay = RETRY_DELAYS[Math.min(this._attempt, RETRY_DELAYS.length - 1)];
      this._attempt += 1;
      this._reconnecting = true;
      this._emit({ type: 'net', event: 'reconnecting', attempt: this._attempt });
      this._clearTimer();
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (this._intentional || this._mode === 'off') return;
        this._open();
      }, delay);
    },

    _giveUp() {
      this._reconnecting = false;
      this._clearTimer();
      this._emit({ type: 'net', event: 'reconnect_failed' });
    },

    _clearTimer() {
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    },

    _send(msg) {
      if (this._ws && this._ws.readyState === 1 /* OPEN */) {
        try { this._ws.send(JSON.stringify(msg)); } catch (e) { /* 忽略发送失败 */ }
      }
    },

    send(msg) { this._send(msg); },

    onOpen(cb) { this._openCb = cb; },
    onMessage(cb) { this._msgCb = cb; },

    isOpen() {
      return !!(this._ws && this._ws.readyState === 1 /* OPEN */);
    },

    /* 上行积压字节数：房主端据此做背压（积压时跳过一次快照），弱网下避免雪崩 */
    bufferedAmount() {
      return (this._ws && this._ws.bufferedAmount) || 0;
    },

    /* 设置 / 清除自定义中继地址（传空字符串即清除并回到同源）。
     * 返回规范化后的地址，非法输入返回 ''。下次 connect() 生效。 */
    setRelay(raw) {
      const u = normalizeRelay(raw);
      try {
        if (u) localStorage.setItem(RELAY_KEY, u);
        else localStorage.removeItem(RELAY_KEY);
      } catch (e) {}
      return u;
    },
    /* 当前生效的中继地址（自定义优先，否则同源 /ws） */
    relayUrl() { return this._url(); },

    disconnect() {
      this._intentional = true;
      this._mode = 'off';
      this._reconnecting = false;
      this._clearTimer();
      if (this._ws) {
        try { this._ws.close(); } catch (e) {}
        this._ws = null;
      }
    },
  };

  global.Net = Net;
  // 供无头测试直接调用
  Net._normalizeRelay = normalizeRelay;
  Net._queryRelay = queryRelay;
  Net.RELAY_KEY = RELAY_KEY;
})(window);
