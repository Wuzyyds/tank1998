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

    _url() {
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
})(window);
