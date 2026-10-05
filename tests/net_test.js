/* =========================================================
 * 双人合作：网络层集成测试 + 同步逻辑单元测试
 *   - 静态：顶层重名函数（函数提升会静默覆盖）
 *   - 集成：启动 server.js，验证 握手/创建/加入/输入中继/快照中继/掉线
 *           + 公网化（健康检查 / 缓存策略 / HEAD / 405 / 保活 ping / Origin 白名单）
 *   - 单元：快照往返含 player2、输入打包对称、玩家集合/命数、友伤关闭
 *   - 单元：net.js 重连状态机 + 中继地址解析（同源 / 自定义 / https 补 wss）
 * 运行：node tests/net_test.js
 * ========================================================= */
'use strict';
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8099;
const results = [];
const assert = (name, ok, extra) => {
  results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (extra ? '   -> ' + extra : ''));
};

/* ---------- 集成：启动服务器 ---------- */
function startServerOn(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, extraEnv, { PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = d => { out += d.toString(); if (out.includes('已启动')) resolve(srv); };
    srv.stdout.on('data', onData);
    srv.stderr.on('data', onData);
    srv.on('error', reject);
    setTimeout(() => resolve(srv), 1200); // 兜底：即使没捕获到日志也继续
  });
}
// 主服务器把保活间隔调小，便于在测试里观察到 ping 帧
function startServer() { return startServerOn(PORT, { WS_PING_MS: '300' }); }

/* ---------- 集成：裸 WS 握手 ----------
 * 浏览器 WebSocket API 不暴露 ping 帧，也无法自定义 Origin，
 * 因此用 http.request 手动发起升级，拿到升级后的裸 socket 观察协议帧。 */
function rawUpgrade(port, origin) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/ws',
      headers: Object.assign({
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      }, origin ? { 'Origin': origin } : {}),
    });
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    req.on('upgrade', (res, socket, head) => finish({ ok: true, socket, head }));
    req.on('response', res => finish({ ok: false, status: res.statusCode }));
    req.on('error', e => finish({ ok: false, error: e.message }));
    setTimeout(() => finish({ ok: null, error: 'timeout' }), 1500);
    req.end();
  });
}

/* 观察服务端是否主动发来 ping 帧（opcode 0x9） */
async function rawPingCheck() {
  const up = await rawUpgrade(PORT);
  if (!up.ok) return 'upgrade failed: ' + (up.error || up.status);
  const isPing = b => b && b.length >= 1 && (b[0] & 0x0f) === 0x9;
  return await new Promise(resolve => {
    const t = setTimeout(() => { try { up.socket.destroy(); } catch (e) {} resolve(false); }, 2000);
    if (isPing(up.head)) { clearTimeout(t); up.socket.destroy(); return resolve(true); }
    up.socket.on('data', chunk => {
      if (isPing(chunk)) { clearTimeout(t); up.socket.destroy(); resolve(true); }
    });
  });
}

/* ---------- 集成：WebSocket 客户端（Node 全局 WebSocket） ---------- */
function wsClient() {
  const WS = globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    const ws = new WS('ws://127.0.0.1:' + PORT + '/ws');
    ws._msgs = [];
    ws.onmessage = ev => { try { ws._msgs.push(JSON.parse(ev.data)); } catch (e) {} };
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}
const waitMsg = (ws, pred, timeout = 2000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const m = ws._msgs.find(pred);
    if (m) return resolve(m);
    if (Date.now() - t0 > timeout) return reject(new Error('timeout waiting msg'));
    setTimeout(tick, 20);
  };
  tick();
});
const send = (ws, obj) => ws.send(JSON.stringify(obj));

async function integration() {
  console.log('\n=== 集成：server.js 中继协议 ===');
  const WS = globalThis.WebSocket;
  if (!WS) { assert('WebSocket 全局可用（Node 22+）', false, '跳过集成测试'); return; }
  const srv = await startServer();
  let code = '';
  try {
    // server 会优先返回真实内网地址；过滤 APIPA（169.254.x.x）与虚拟网卡
    const lanResp = await fetch('http://127.0.0.1:' + PORT + '/lan');
    const lanJson = await lanResp.json();
    assert('/lan 端点返回 JSON 且端口一致', lanResp.ok && lanJson.port === PORT && typeof lanJson.url === 'string', JSON.stringify(lanJson));
    assert('/lan 不返回 169.254.x.x APIPA 地址', !lanJson.ip || !/^169\.254\./.test(lanJson.ip), lanJson.ip);
    assert('/lan 不返回 127.x.x.x 本机回环', !lanJson.ip || !/^127\./.test(lanJson.ip), lanJson.ip);

    const H = await wsClient();
    send(H, { type: 'room', action: 'create' });
    const created = await waitMsg(H, m => m.type === 'room' && m.action === 'created');
    assert('房主创建房间返回 4 位房间号', typeof created.code === 'string' && created.code.length === 4, created.code);
    code = created.code;

    const G = await wsClient();
    send(G, { type: 'room', action: 'join', code });
    const joined = await waitMsg(G, m => m.type === 'room' && m.action === 'joined');
    assert('客方加入房间成功', !!joined, JSON.stringify(joined));
    const ph = await waitMsg(H, m => m.type === 'peer' && m.event === 'joined');
    assert('房主收到 peer.joined 通知', !!ph);

    // 输入中继：客方 -> 房主
    send(G, { type: 'input', k: 5 });
    const inRelay = await waitMsg(H, m => m.type === 'input' && m.k === 5);
    assert('输入从客方中继到房主（带 from 标签）', inRelay && inRelay.from === 'guest', JSON.stringify(inRelay));

    // 快照中继：房主 -> 客方（含 player2）
    const snap = { p2: { exists: true }, lives2: 3, score: 42 };
    send(H, { type: 'state', snap });
    const stRelay = await waitMsg(G, m => m.type === 'state' && m.snap && m.snap.p2 && m.snap.p2.exists === true);
    assert('快照从房主中继到客方（含 player2）', !!stRelay && stRelay.from === 'host', JSON.stringify(stRelay && stRelay.snap));

    // 无效房间号
    const G2 = await wsClient();
    send(G2, { type: 'room', action: 'join', code: '0000' });
    const notFound = await waitMsg(G2, m => m.type === 'error' && m.code === 'ROOM_NOT_FOUND');
    assert('加入不存在的房间返回 ROOM_NOT_FOUND', !!notFound);
    G2.close();

    // 静态资源：PWA 清单 / 图标 / Service Worker 应可访问且 MIME 正确
    const mRes = await fetch('http://127.0.0.1:' + PORT + '/manifest.webmanifest');
    const mType = mRes.headers.get('content-type') || '';
    assert('manifest.webmanifest 以 manifest+json 提供', mRes.status === 200 && mType.indexOf('manifest') >= 0, mRes.status + ' ' + mType);
    const iRes = await fetch('http://127.0.0.1:' + PORT + '/assets/icons/icon-192.png');
    assert('PWA 图标以 image/png 提供', iRes.status === 200 && (iRes.headers.get('content-type') || '').indexOf('image/png') >= 0, iRes.status + ' ' + (iRes.headers.get('content-type') || ''));
    const swRes = await fetch('http://127.0.0.1:' + PORT + '/sw.js');
    assert('Service Worker 可访问', swRes.status === 200 && (swRes.headers.get('content-type') || '').indexOf('javascript') >= 0, swRes.status);

    // 公网化：健康检查 / 缓存策略 / 方法限制 / 保活 / Origin 白名单
    const hzRes = await fetch('http://127.0.0.1:' + PORT + '/healthz');
    const hzJson = await hzRes.json();
    assert('/healthz 返回 ok + uptime + 房间数 + 连接数',
      hzRes.status === 200 && hzJson.ok === true && typeof hzJson.uptimeMs === 'number' &&
      typeof hzJson.rooms === 'number' && typeof hzJson.connections === 'number',
      JSON.stringify(hzJson));

    const ccOf = r => (r.headers.get('cache-control') || '');
    const rootRes = await fetch('http://127.0.0.1:' + PORT + '/');
    assert('入口 HTML / Service Worker / 清单均为 no-cache（发版不被旧缓存卡住）',
      ccOf(rootRes) === 'no-cache' && ccOf(swRes) === 'no-cache' && ccOf(mRes) === 'no-cache',
      JSON.stringify({ html: ccOf(rootRes), sw: ccOf(swRes), man: ccOf(mRes) }));
    assert('静态资源短缓存 + nosniff + Content-Length',
      ccOf(iRes).indexOf('max-age=') >= 0 && iRes.headers.get('x-content-type-options') === 'nosniff' &&
      Number(iRes.headers.get('content-length')) > 0,
      JSON.stringify({ cc: ccOf(iRes), len: iRes.headers.get('content-length') }));

    const headRes = await fetch('http://127.0.0.1:' + PORT + '/', { method: 'HEAD' });
    const headBody = await headRes.text();
    assert('HEAD / 返回 200 + Content-Length 且无响应体',
      headRes.status === 200 && Number(headRes.headers.get('content-length')) > 0 && headBody.length === 0,
      JSON.stringify({ status: headRes.status, len: headRes.headers.get('content-length'), body: headBody.length }));

    const postRes = await fetch('http://127.0.0.1:' + PORT + '/', { method: 'POST' });
    assert('非 GET/HEAD 返回 405 并声明 Allow',
      postRes.status === 405 && /\bGET\b/.test(postRes.headers.get('allow') || ''),
      postRes.status + ' allow=' + postRes.headers.get('allow'));

    assert('服务端定期发送 WebSocket ping 保活帧（防反代/NAT 掐空闲连接）',
      (await rawPingCheck()) === true);

    // Origin 白名单：单独起一个设了 ALLOW_ORIGIN 的实例
    const PORT2 = PORT + 1;
    const srv2 = await startServerOn(PORT2, { ALLOW_ORIGIN: 'http://allowed.example' });
    try {
      const evil = await rawUpgrade(PORT2, 'http://evil.example');
      assert('ALLOW_ORIGIN：非白名单来源的 WS 握手被拒绝',
        evil.ok !== true, String(evil.error || evil.status || ''));
      const good = await rawUpgrade(PORT2, 'http://allowed.example');
      assert('ALLOW_ORIGIN：白名单来源可正常升级', good.ok === true, String(good.error || good.status || ''));
      if (good.socket) { try { good.socket.destroy(); } catch (e) {} }
      const noOrigin = await rawUpgrade(PORT2);
      assert('ALLOW_ORIGIN：无 Origin（非浏览器客户端）放行', noOrigin.ok === true, String(noOrigin.error || noOrigin.status || ''));
      if (noOrigin.socket) { try { noOrigin.socket.destroy(); } catch (e) {} }
    } finally { srv2.kill(); }

    // 页面结构：设置弹窗（音量/画面）、难度选择行、手机端 HUD、中继面板、画面内菜单必须存在，
    // 否则按钮静默失效（点了没反应，且不会有任何报错）
    const html = await (await fetch('http://127.0.0.1:' + PORT + '/')).text();
    const need = ['id="set-overlay"', 'id="vol-master"', 'id="vol-sfx"', 'id="vol-music"', 'id="chk-bgm"',
                  'id="set-fit"', 'id="set-fs"', 'id="set-flash"',
                  'id="diff-row"', 'id="diff-pick"',
                  'id="hud-weapon"', 'id="hud-weapon2"',
                  'id="relay-url"', 'id="btn-relay"', 'id="relay-now"', 'id="coop-lan"',
                  'id="center-actions"', 'id="ca-start"', 'id="ca-restart"', 'id="ca-resume"', 'id="ca-next"',
                  'id="ca-title"', 'id="ca-coop"', 'id="ca-codex"', 'id="ca-set"', 'id="ca-mute"',
                  'id="play-ctl"', 'id="ctl-pause"', 'id="ctl-mute"'];
    const missing = need.filter(s => html.indexOf(s) < 0);
    assert('index.html 含设置弹窗 / HUD / 中继面板 / 画面内菜单（DOM id 齐全）', missing.length === 0, 'missing=' + missing.join(','));

    /* 反向检查：原先画布上方的工具栏与页脚说明必须已经移除。
     * 否则会出现「两套入口并存」——工具栏在手机上离拇指很远，用户以为没做改动。 */
    const banned = ['class="toolbar"', '<footer', 'id="btn-start"', 'id="btn-pause"', 'id="set-panel"',
                    'id="seg-hp"'];
    const stillThere = banned.filter(s => html.indexOf(s) >= 0);
    assert('index.html 已移除顶部工具栏、页脚说明与「血量档位」（按钮全部搬进画面内）',
      stillThere.length === 0, 'still=' + stillThere.join(','));

    /* 暂停同步：pause 与 start 都走同一条中继通路（服务器是纯透传，不解析类型）。
     * 两个方向都要验证——房主广播下行、客方请求上行。 */
    send(H, { type: 'pause', v: 1 });
    const pauseH2G = await waitMsg(G, m => m.type === 'pause');
    assert('暂停消息经中继送达客方（房主广播下行）',
      !!pauseH2G && pauseH2G.v === 1 && pauseH2G.from === 'host', JSON.stringify(pauseH2G));
    send(G, { type: 'pause', v: 1 });
    const pauseG2H = await waitMsg(H, m => m.type === 'pause');
    assert('客方的暂停请求经中继送达房主（客方发起上行）',
      !!pauseG2H && pauseG2H.v === 1 && pauseG2H.from === 'guest', JSON.stringify(pauseG2H));

    // 客方点画面内按钮的「开始 / 重新开始 / 下一关」：请求交给房主执行
    send(G, { type: 'start', act: 'restart' });
    const startRelay = await waitMsg(H, m => m.type === 'start' && m.act === 'restart');
    assert('客方的开局请求经中继送达房主（start 通路）', !!startRelay, JSON.stringify(startRelay));

    // 掉线通知：关闭客方，房主应收到 peer.dropped
    const dropP = waitMsg(H, m => m.type === 'peer' && m.event === 'dropped', 3000);
    G.close();
    const dropped = await dropP;
    assert('客方掉线，房主收到 peer.dropped', !!dropped);
    assert('客方加入时拿到重连令牌', typeof joined.token === 'string' && joined.token.length > 8);

    // 断线重连：凭令牌抢回原角色
    const G3 = await wsClient();
    send(G3, { type: 'room', action: 'rejoin', code, token: joined.token });
    const rej = await waitMsg(G3, m => m.type === 'room' && m.action === 'rejoined');
    assert('客方凭令牌重连成功（rejoined）', !!rej && rej.role === 'guest', JSON.stringify(rej));
    const prj = await waitMsg(H, m => m.type === 'peer' && m.event === 'rejoined');
    assert('房主收到 peer.rejoined 通知', !!prj && prj.role === 'guest', JSON.stringify(prj));

    // 重连后中继链路恢复
    send(G3, { type: 'input', k: 7 });
    const relay2 = await waitMsg(H, m => m.type === 'input' && m.k === 7);
    assert('重连后输入中继恢复', !!relay2 && relay2.from === 'guest', JSON.stringify(relay2));

    // 错误令牌应被拒绝
    const G4 = await wsClient();
    send(G4, { type: 'room', action: 'rejoin', code, token: 'wrong-token' });
    const badTok = await waitMsg(G4, m => m.type === 'error' && m.code === 'REJOIN_FAILED');
    assert('错误令牌重连被拒绝（REJOIN_FAILED）', !!badTok);
    G4.close();
    G3.close();

    H.close();
  } catch (e) {
    assert('集成测试执行无异常', false, e.message);
  } finally {
    srv.kill();
  }
}

/* ---------- 静态检查：顶层重名函数 ----------
 * server.js 曾同时存在 HTTP 版与 WebSocket 版的 sendJson：函数声明会提升、
 * 后声明的静默覆盖先声明的，导致 HTTP 响应永不 end()，请求一直挂着。
 * 这里用最朴素的文本扫描把同类问题挡在提交之前。 */
function staticChecks() {
  console.log('\n=== 静态检查：顶层重名函数 ===');
  const report = {};
  let clean = true;
  for (const f of ['server.js', 'game.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /^function\s+([A-Za-z_$][\w$]*)/gm;
    const seen = Object.create(null);
    const dup = [];
    let m;
    while ((m = re.exec(src))) { if (seen[m[1]]) dup.push(m[1]); seen[m[1]] = 1; }
    if (dup.length) clean = false;
    report[f] = dup;
  }
  assert('server.js / game.js 无顶层重名函数（重名会被静默覆盖）', clean, JSON.stringify(report));

  /* 消息类型白名单：server.js 的转发是显式列举 type 的，game.js 新增一种消息
   * 却忘了登记，症状是「本机自测全对、联机完全无效」——极难被发现。这里静态比对。 */
  const gjSrc = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
  const svSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const used = new Set();
  const reSend = /Net\.send\(\{\s*type\s*:\s*'([a-z]+)'/g;
  let ms;
  while ((ms = reSend.exec(gjSrc))) used.add(ms[1]);
  const wlLine = (svSrc.match(/type === 'input'[^\n]*/) || [''])[0];
  const notRelayed = [];
  for (const t of used) {
    if (t === 'room' || t === 'ping') continue;   // 控制类消息由 server 自己消费，不进转发白名单
    if (wlLine.indexOf("'" + t + "'") < 0) notRelayed.push(t);
  }
  assert('game.js 发送的消息类型都已在 server.js 转发白名单中（防静默丢弃）',
    notRelayed.length === 0,
    'missing=' + notRelayed.join(',') + ' | used=' + Array.from(used).join(','));

  /* 快照发送条件：过关(clear) / 结束(over) 也必须发快照 —— 原先只在 playing 时发，
   * 联机实测表现为「房主过关后客方画面冻住数秒，且永远看不到关卡完成 / GAME OVER」。 */
  const snapOk = gjSrc.indexOf("} else if (state !== 'title' && Net.bufferedAmount() < SNAP_BACKPRESSURE){") >= 0;
  assert('房主在过关 / 结束时也发快照（否则客方停在上一帧、看不到结算界面）', snapOk,
    snapOk ? '' : '未找到 clear/over 也发快照的条件');

  /* ---- 联机手感（v1.6.1）：三条「改回去就会明显变卡 / 变延迟」的静态锁 ---- */
  const tickM = /const NET_TICK = 1 \/ (\d+);/.exec(gjSrc);
  const tickHz = tickM ? +tickM[1] : 0;
  assert('收发节拍 ≥30Hz（原先 20Hz：客方画面 50ms 才刷一次、按键最坏等 50ms 才发出）',
    tickHz >= 30, 'NET_TICK = 1/' + (tickHz || '?') + ' s');

  const bpM = /const SNAP_BACKPRESSURE = (\d+);/.exec(gjSrc);
  const bp = bpM ? +bpM[1] : 0;
  assert('发送缓冲上限 ≤64KB（原先 256KB ≈ 允许积压 4 秒快照，弱网下延迟一路叠加）',
    bp > 0 && bp <= 65536, 'SNAP_BACKPRESSURE = ' + (bp || '?') + ' 字节');

  const inputImmediate =
    gjSrc.indexOf('function sendGuestInput(){') >= 0 &&
    gjSrc.indexOf('if (keys2[code] === val) return;') >= 0 &&
    gjSrc.indexOf('    sendGuestInput();') >= 0;
  assert('客方按键一变化就立刻发包（不再干等节拍器，消掉 0~33ms 输入采样延迟）', inputImmediate,
    inputImmediate ? '' : 'setKey 的客方分支未做到「变化即发」');

  const turnImmediate =
    gjSrc.indexOf('function wantDir(t, want){') >= 0 &&
    gjSrc.indexOf('drivePlayerTank(player, keys, dt);') >= 0 &&
    gjSrc.indexOf('player.pendingDir = want') < 0 &&
    gjSrc.indexOf('player2.pendingDir = want') < 0;
  assert('转向即时：移动中改方向下一帧即生效（原先一律「走完当前格再转向」≈385ms）', turnImmediate,
    turnImmediate ? '' : '未走 wantDir / 仍无条件写 pendingDir');

  const predOk =
    gjSrc.indexOf('function predictGuestPlayer2(dt){') >= 0 &&
    gjSrc.indexOf('    else predictGuestPlayer2(dt);') >= 0 &&
    gjSrc.indexOf('const PRED_TOL = ') >= 0;
  assert('客方本地预测已接入（画面立刻响应），且带容差对账（防跑飞 / 防抖动）', predOk,
    predOk ? '' : '未找到 predictGuestPlayer2 的定义或调用');
}

/* ---------- CLI 配置校验 ----------
 * TLS 是公网上线的主路径：半配置（只给证书不给私钥）必须在启动时就明确报错，
 * 而不是静默降级成明文 http —— 那会让部署者误以为已经在用 HTTPS。 */
function runCli(args, timeout = 5000) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server.js')].concat(args), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} resolve({ code: null, out, err }); }, timeout);
    p.on('exit', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

async function cliChecks() {
  console.log('\n=== CLI：TLS / 帮助 配置校验 ===');
  const help = await runCli(['--help']);
  assert('--help 退出码 0 且打印用法', help.code === 0 && help.out.indexOf('用法') >= 0, 'code=' + help.code);
  assert('--help 列出 --public-url（公网部署用）', help.out.indexOf('--public-url') >= 0);

  const half = await runCli(['--tls-cert', 'x.pem', '--port', '8123']);
  assert('只给证书不给私钥时拒绝启动（不静默降级为明文）',
    half.code === 1 && half.err.indexOf('证书与私钥必须同时提供') >= 0,
    'code=' + half.code + ' err=' + half.err.trim());

  const missing = await runCli(['--tls-cert', '_no_cert.pem', '--tls-key', '_no_key.pem', '--port', '8123']);
  assert('证书文件不存在时报错并退出',
    missing.code === 1 && missing.err.indexOf('读取证书') >= 0,
    'code=' + missing.code + ' err=' + missing.err.trim());
}

/* ---------- 集成：PUBLIC_URL 覆盖 /lan 的对外地址 ----------
 * 公网部署在反代后面时，/lan 若返回服务器内网 IP，联机面板会给访客一个
 * 完全不可达的地址。设了 PUBLIC_URL 之后必须原样返回它（末尾斜杠归一）。 */
function publicUrlCheck() {
  console.log('\n=== 集成：PUBLIC_URL 覆盖 /lan 对外地址 ===');
  const P = 8126, WANT = 'http://203.0.113.9:8000';
  return new Promise(resolve => {
    const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(P), PUBLIC_URL: WANT + '/' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let fired = false, out = '';
    const done = async () => {
      if (fired) return;
      fired = true;
      try {
        const r = await fetch('http://127.0.0.1:' + P + '/lan');
        const j = await r.json();
        assert('PUBLIC_URL 生效：/lan 返回对外地址（末尾斜杠已归一）',
          j.url === WANT && j.public === true, JSON.stringify(j));
      } catch (e) {
        assert('PUBLIC_URL 生效：/lan 返回对外地址', false, e.message);
      } finally {
        try { srv.kill(); } catch (e) {}
        resolve();
      }
    };
    const onData = d => { out += d.toString(); if (out.indexOf('已启动') >= 0) done(); };
    srv.stdout.on('data', onData);
    srv.stderr.on('data', onData);
    setTimeout(done, 1500);   // 兜底：没捕获到启动日志也继续
  });
}

/* ---------- 单元：在 vm 沙箱中加载 game.js 测同步逻辑 ---------- */
function unit() {
  console.log('\n=== 单元：game.js 同步逻辑 ===');
  const noop = () => {};
  const ctxStub = new Proxy({}, { get: (t, p) => (p in t ? t[p] : noop), set: (t, p, v) => { t[p] = v; return true; } });
  const mkEl = id => ({
    id, addEventListener: noop, removeEventListener: noop,
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    dataset: {}, style: {}, textContent: '', disabled: false,
    getContext: () => ctxStub, requestFullscreen: noop, webkitRequestFullscreen: noop,
  });
  const EL_CACHE = {};
  const sandbox = {
    console, vnow: 0, RAF_CB: null,
    Image: class { set src(v){ if (this.onload) this.onload(); } },
    Audio: class { play(){ return Promise.resolve(); } },
    window: { addEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined },
    document: {
      getElementById: id => (EL_CACHE[id] || (EL_CACHE[id] = mkEl(id))),
      querySelectorAll: () => [], addEventListener: noop,
      createElement: () => ({ getContext: () => ctxStub }),
      body: mkEl('body'), fullscreenElement: null, hidden: false,
    },
    localStorage: { getItem: () => '0', setItem: noop, removeItem: noop },
    performance: { now: () => sandbox.vnow },
    requestAnimationFrame: cb => { sandbox.RAF_CB = cb; return 1; },
    setTimeout: noop,
    fetch: () => Promise.reject(new Error('no network')),
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/sounds.js'), 'utf8'), context, { filename: 'sounds.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, { filename: 'game.js' });

  // 进入双人房主模式并开局
  vm.runInContext("netMode='host'; startGame();", context);
  const hasP2 = vm.runInContext("!!player2 && player2.isPlayer === true", context);
  assert('房主开局生成玩家2（独立坦克）', hasP2);

  // 快照往返：player2 与 lives2 保留
  const round = vm.runInContext("(function(){ var s = serializeSnapshot(); var before = {p2: !!s.p2, lives2: s.lives2}; applySnapshot(s); return {before: before, after: {p2: !!player2, lives2: lives2}}; })()", context);
  assert('快照含 player2 且 applySnapshot 还原 player2', round.before.p2 && round.after.p2, JSON.stringify(round));
  assert('快照往返保留 lives2', round.before.lives2 === 2 && round.after.lives2 === 2, JSON.stringify(round));

  // 武器/火力挂在各自坦克上，快照逐坦克携带 → 联机下玩家2 的状态同样独立（不共享）
  const wRound = vm.runInContext(`(function(){
    player.power = 3; player.gun = 'flame'; player.ammo = 7;
    player2.power = 1; player2.gun = 'tesla'; player2.ammo = 4;
    var s = serializeSnapshot();
    player.power = 1; player.gun = 'normal'; player.ammo = 0;
    player2.power = 2; player2.gun = 'normal'; player2.ammo = 0;
    applySnapshot(s);
    return { p1:[player.power, player.gun, player.ammo], p2:[player2.power, player2.gun, player2.ammo] };
  })()`, context);
  assert('快照各自携带武器/火力：玩家2 与玩家1 完全独立（不共享）',
    JSON.stringify(wRound.p1) === JSON.stringify([3, 'flame', 7]) &&
    JSON.stringify(wRound.p2) === JSON.stringify([1, 'tesla', 4]),
    JSON.stringify(wRound));

  /* 暂停同步：暂停标记必须进快照，作为 pause 消息丢包时的兜底；
   * 客方 applySnapshot 时要「跟随但不再回广播」，否则两边会互相回环。 */
  const pz = vm.runInContext("(function(){" +
    "setPaused(false,false); var off = serializeSnapshot().pz;" +
    "setPaused(true,false);  var on  = serializeSnapshot().pz;" +
    "netMode='guest'; applySnapshot(serializeSnapshot()); var follow = paused;" +
    "netMode='host'; setPaused(false,false); return {off:off, on:on, follow:follow};" +
  "})()", context);
  assert('暂停标记进快照（pz），客方应用后跟随暂停',
    pz.off === 0 && pz.on === 1 && pz.follow === true, JSON.stringify(pz));

  // 输入打包对称
  const packSym = vm.runInContext("(function(){ var k = {ArrowUp:true, Space:true}; var b = packInput(k); var u = unpackInput(b); return u.ArrowUp === true && u.Space === true && u.ArrowDown === false; })()", context);
  assert('packInput/unpackInput 对称（上+开火）', packSym);

  // 玩家集合：双人返回两人，单人返回一人
  const pt = vm.runInContext("(function(){ var coop = playerTargets().length; netMode='off'; player2=null; var solo = playerTargets().length; netMode='host'; return {coop:coop, solo:solo}; })()", context);
  assert('playerTargets：双人=2 单人=1', pt.coop === 2 && pt.solo === 1, JSON.stringify(pt));

  // 命数判定
  const bol = vm.runInContext("(function(){ netMode='host'; player2={isPlayer:true,dead:false}; lives=0; lives2=2; var a=bothOutOfLives(); lives2=0; var b=bothOutOfLives(); return {a:a,b:b}; })()", context);
  assert('bothOutOfLives：仅 P1 没命不算结束；两人都没命才结束', bol.a === false && bol.b === true, JSON.stringify(bol));

  // 友伤关闭：玩家子弹的命中目标列表只含敌人，不含玩家
  const ff = vm.runInContext("(function(){ netMode='host'; player2={isPlayer:true,dead:false,px:100,py:100,x:5,y:5}; player={isPlayer:true,dead:false,px:200,py:200,x:10,y:10}; enemies=[]; var bEmpty={owner:{isPlayer:true},px:0,py:0}; var t1 = nearestTarget(bEmpty); enemies=[{isPlayer:false,dead:false,px:300,py:300,x:15,y:15}]; var bEnemy={owner:{isPlayer:true},px:0,py:0}; var t2 = nearestTarget(bEnemy); return {emptyEnemy: t1, withEnemy: t2 && t2.isPlayer===false}; })()", context);
  assert('友伤关闭：玩家子弹在无敌人时不锁定玩家', ff.emptyEnemy === null || ff.emptyEnemy === undefined, JSON.stringify(ff));
  assert('友伤关闭：玩家子弹优先锁定敌人而非玩家', ff.withEnemy === true);

  // 过关继承火力等级：nextLevel 后 P1/P2 应保留上关 power
  const carry = vm.runInContext("(function(){ netMode='host'; player.power=3; player2.power=2; var lvl0=level; nextLevel(); return {lvl0:lvl0, lvl1:level, pPow:player.power, p2Pow:player2?player2.power:null}; })()", context);
  assert('nextLevel 后关卡数 +1', carry.lvl1 === carry.lvl0 + 1, JSON.stringify(carry));
  assert('过关继承玩家火力（P1 power=3 保留）', carry.pPow === 3, JSON.stringify(carry));
  assert('过关继承玩家火力（P2 power=2 保留）', carry.p2Pow === 2, JSON.stringify(carry));

  // 单关内复活保留火力：player 阵亡且仍有命，updatePlayer 复活后应保留 power
  const respawn = vm.runInContext("(function(){ netMode='off'; player2=null; player.power=2; player.dead=true; player.deadTimer=0.1; lives=3; updatePlayer(0.2); return {pow: player.power, dead: player.dead}; })()", context);
  assert('复活后火力重置为 1 级', respawn.pow === 1 && respawn.dead === false, JSON.stringify(respawn));

  // 无障碍：减少动效把高倍闪烁限制到 <=3Hz（WCAG 2.3.1）
  const rm = vm.runInContext("(function(){ function starts(hz, reduce, dur){ reduceMotion = reduce; var c = 0, prev = null; for (var t = 0; t < dur; t += 0.005){ gameTime = t; var on = flashOn(hz); if (prev === false && on) c++; prev = on; } return c; } var normal = starts(10, false, 2); var reduced = starts(10, true, 2); reduceMotion = false; return { normal: normal, reduced: reduced, cap: FLASH_HZ_MAX }; })()", context);
  assert('减少动效：正常时 10Hz 闪烁每秒亮起约 5 次', rm.normal >= 9 && rm.normal <= 11, JSON.stringify(rm));
  assert('减少动效：开启后闪烁上限 ≤3Hz（2 秒内亮起 ≤4 次）', rm.reduced >= 2 && rm.reduced <= 4 && rm.cap === 3, JSON.stringify(rm));

  // 高分屏：按 devicePixelRatio 放大画布背板（逻辑坐标仍是 680x520）
  const hp = vm.runInContext("(function(){ var out = {}; window.devicePixelRatio = 2; setupHiDPI(); out.dpr = DPR; out.cw = canvas.width; out.ch = canvas.height; window.devicePixelRatio = undefined; setupHiDPI(); out.restore = DPR; return out; })()", context);
  assert('高分屏：DPR=2 时背板放大为 1360x1040', hp.dpr === 2 && hp.cw === 1360 && hp.ch === 1040, JSON.stringify(hp));
  assert('高分屏：无 DPR 时回退为 1（680x520）', hp.restore === 1, JSON.stringify(hp));

  // 手机端 DOM HUD：核心信息同步正确（触屏下 canvas 面板被 CSS 裁掉，信息改由 DOM 呈现）
  const hud = vm.runInContext("(function(){ netMode='off'; player2=null; score=1234; lives=2; lives2=3; level=7; player.power=3; enemyQueue=['basic','fast']; enemies=[]; syncHud(); var r={score:hudScore.textContent, lives:hudLives.textContent, level:hudLevel.textContent, power:hudPower.textContent, enemy:hudEnemy.textContent, coarse:coarsePointer}; score=0; return r; })()", context);
  assert('DOM HUD：分数补零为 6 位', hud.score === '001234', JSON.stringify(hud));
  assert('DOM HUD：生命/关卡/火力/敌余同步正确（关卡槽为「难度-关号」）', hud.lives === '♥♥' && hud.level === '2-2' && hud.power === 'Lv3' && hud.enemy === '02', JSON.stringify(hud));
  /* 关卡槽要在 BOSS / 精英关带标记：难度 2 的第 4 关（精英）= level 9、第 5 关（BOSS）= level 10 */
  const hudMark = vm.runInContext("(function(){ level = 10; syncHud(); var a = hudLevel.textContent; level = 9; syncHud(); var b = hudLevel.textContent; return { boss: a, elite: b }; })()", context);
  assert('DOM HUD：关卡槽在 BOSS / 精英关带标记', hudMark.boss === '2-5·BOSS' && hudMark.elite === '2-4·精英', JSON.stringify(hudMark));
  assert('DOM HUD：非触屏环境不启用（coarsePointer=false，桌面走 canvas 面板）', hud.coarse === false);

  // 重开一局必须重置火力等级（基地被摧毁 / 生命耗尽后重开，不能带着上一局的火力）
  const fresh = vm.runInContext("(function(){ netMode='off'; player2=null; player.power=3; level=5; lives=1; startGame(); return {pow: player.power, lvl: level, lives: lives}; })()", context);
  assert('重开一局：火力等级回到 1 级（不再继承上局）', fresh.pow === 1, JSON.stringify(fresh));
  assert('重开一局：关卡回到 01 且命数重置为 2', fresh.lvl === 1 && fresh.lives === 2, JSON.stringify(fresh));

  // 完整复现用户报的场景：打到第 2 关（火力 Lv3）基地被摧毁 → GAME OVER → 点按重开
  const replay = vm.runInContext("(function(){ netMode='off'; player2=null; startGame(); level=2; player.power=3; player.gun='laser'; player.ammo=5; destroyBase(); var st1 = state; gameTime += 2; requestStart(); return { st1: st1, st2: state, pow: player.power, lvl: level, gun: player.gun, ammo: player.ammo }; })()", context);
  assert('基地被摧毁 → 点按重开：状态恢复 playing 且火力回到 Lv1', replay.st1 === 'over' && replay.st2 === 'playing' && replay.pow === 1, JSON.stringify(replay));
  assert('基地被摧毁 → 点按重开：关卡回到 01、武器清空为普通弹', replay.lvl === 1 && replay.gun === 'normal' && replay.ammo === 0, JSON.stringify(replay));

  // 武器字母标识：7 种武器全覆盖且互不重复
  const wl = vm.runInContext("(function(){ var miss = WEAPON_TYPES.filter(function(t){ return !WEAPON_LETTER[t]; }); var seen = {}, dup = []; WEAPON_TYPES.forEach(function(t){ var L = WEAPON_LETTER[t]; if (seen[L]) dup.push(L); seen[L] = 1; }); return {total: WEAPON_TYPES.length, miss: miss, dup: dup, ls: WEAPON_LETTER.laser + WEAPON_LETTER.spread}; })()", context);
  assert('武器字母：7 种武器均有字母标识', wl.total === 7 && wl.miss.length === 0, JSON.stringify(wl));
  assert('武器字母：字母唯一（激光=L 散弹=S）', wl.dup.length === 0 && wl.ls === 'LS', JSON.stringify(wl));

  // 地图上的武器道具绘制字母（而非 20x20 矢量小图标）
  const wi = vm.runInContext("(function(){ var c = canvas.getContext('2d'); var orig = c.fillText, txt = []; c.fillText = function(t){ txt.push(String(t)); }; drawItem({x:1,y:1,t:0,type:'flame'}); drawItem({x:1,y:1,t:0,type:'drill'}); c.fillText = orig; return txt; })()", context);
  assert('武器道具：地图上绘制字母 F / D', wi.indexOf('F') >= 0 && wi.indexOf('D') >= 0, JSON.stringify(wi));

  // 结束 / 标题 / 过关界面排版：逐行累加 y，行与行不得重叠。
  // 画面里的「点击下方按钮 或 按 Enter …」提示已删除：主入口改成画面内菜单，
  // 再留一行「点下面按钮」的说明只会与按钮抢位置（手机屏幕本来就矮）。
  const ovl = vm.runInContext("(function(){ var c = canvas.getContext('2d'); var orig = c.fillText; function cap(fn){ var rec = []; c.fillText = function(t,x,y){ rec.push({ t:String(t), y:y }); }; fn(); c.fillText = orig; return rec; } return { over: cap(drawOver), title: cap(drawTitle), clear: cap(drawClear) }; })()", context);
  const gapsOk = (arr, min) => arr.length >= min && arr.every((r, i) => i === 0 || (r.y - arr[i-1].y) >= 20);
  assert('GAME OVER 排版：3 行递增且行距充足（得分不被提示覆盖）', ovl.over.length === 3 && gapsOk(ovl.over, 3), JSON.stringify(ovl.over));
  assert('标题（4 行）/ 过关（3~4 行：完成 / 得分 / 倒计时）排版：行距充足，且已无「点击下方按钮」文字',
    gapsOk(ovl.title, 4) && gapsOk(ovl.clear, 2) &&
    !ovl.over.concat(ovl.title, ovl.clear).some(r => /点击下方按钮|按 Enter/.test(r.t)),
    JSON.stringify({ title: ovl.title.length, clear: ovl.clear.length }));

  // 地形离屏缓存：开局整张重建一次，之后无变化零重绘；打掉一块砖只重画 3x3 邻域
  const tc = vm.runInContext("(function(){ netMode='off'; player2=null; startGame(); var c = canvas.getContext('2d'); var oF = c.fillRect, n = 0; c.fillRect = function(){ n++; }; flushTerrain(); var full = n; n = 0; flushTerrain(); var idle = n; n = 0; render(); n = 0; flushTerrain(); var afterRender = n; n = 0; var hit = null; for (var r = 1; r < ROWS - 1 && !hit; r++) for (var cc = 1; cc < COLS - 1; cc++){ if (map[r][cc] !== BRICK) continue; var nb = 0; for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++){ if (!dr && !dc) continue; if (isTerrainCacheable(map[r+dr][cc+dc])) nb++; } if (nb > 0){ hit = [r, cc]; break; } } var boxes = []; c.fillRect = function(x,y,w,h){ n++; boxes.push([x,y,w,h]); }; if (hit) setTile(hit[0], hit[1], EMPTY); flushTerrain(); c.fillRect = oF; var outOfRange = hit ? boxes.filter(function(b){ return b[0] < (hit[1]-1)*TILE - 0.01 || b[1] < (hit[0]-1)*TILE - 0.01 || b[0]+b[2] > (hit[1]+2)*TILE + 0.01 || b[1]+b[3] > (hit[0]+2)*TILE + 0.01; }).length : 0; return { full: full, idle: idle, afterRender: afterRender, dirty: n, hit: hit, outOfRange: outOfRange, tile: map[hit[0]][hit[1]] }; })()", context);
  assert('地形缓存：开局整张重建（>100 个矩形）', tc.full > 100, JSON.stringify({ full: tc.full }));
  assert('地形缓存：无变化时零重绘（idle=0，render 后仍为 0）', tc.idle === 0 && tc.afterRender === 0, JSON.stringify(tc));
  assert('地形缓存：打掉一块砖只重画 3x3 邻域（矩形不越界，且确实有重绘）', tc.dirty > 0 && tc.dirty < tc.full && tc.outOfRange === 0 && tc.tile === 0, JSON.stringify(tc));

  // 难度阶梯：每 5 关一档，第 4 关精英、第 5 关 BOSS
  const tierInfo = vm.runInContext("(function(){ var o = {}; level = 1; o.t1 = tier().name; level = 6; o.t6 = tier().name; level = 11; o.t11 = tier().name; level = 21; o.t21 = tier().name; level = 40; o.t40 = tier().name; level = 4; o.elite4 = isEliteLevel(); o.boss4 = isBossLevel(); level = 5; o.boss5 = isBossLevel(); o.elite5 = isEliteLevel(); level = 9; o.elite9 = isEliteLevel(); return o; })()", context);
  assert('难度阶梯：每 5 关一档（1 新兵 / 6 老兵 / 11 精锐 / 21 噩梦，超过 5 档封顶）', tierInfo.t1 === '新兵' && tierInfo.t6 === '老兵' && tierInfo.t11 === '精锐' && tierInfo.t21 === '噩梦' && tierInfo.t40 === '噩梦', JSON.stringify(tierInfo));
  assert('关卡标签：第 4 关=精英关、第 5 关=BOSS、第 9 关=精英关', tierInfo.elite4 === true && tierInfo.boss4 === false && tierInfo.boss5 === true && tierInfo.elite5 === false && tierInfo.elite9 === true, JSON.stringify(tierInfo));

  // 难度参数确实随档位变化（旧实现 8~10 关后就全部封顶）
  const diff = vm.runInContext("(function(){ level = 1; var a = { spd: enemySpeedMul(), hp: makeTank(1,1,0,'basic',{}).hp, total: buildQueue().length }; level = 21; var b = { spd: enemySpeedMul(), hp: makeTank(1,1,0,'basic',{}).hp, total: buildQueue().length, bossHp: makeTank(1,1,0,'boss',{}).hp, smart: TIERS[4].smart }; return { a: a, b: b }; })()", context);
  assert('难度：1 关基础敌人 1 血 / 速度 x1.0 / 队列 24', diff.a.hp === 1 && diff.a.spd === 1 && diff.a.total === 24, JSON.stringify(diff));
  assert('难度：21 关（噩梦）基础敌人 3 血 / 速度 x1.32 / 队列 35', diff.b.hp === 3 && diff.b.spd === 1.32 && diff.b.total === 35, JSON.stringify(diff));
  assert('难度：BOSS 不吃档位加血（固定 10 血）', diff.b.bossHp === 10, JSON.stringify(diff));

  // BOSS 关首领压轴；精英关前段插入 3 只精英
  const q5 = vm.runInContext("(function(){ level = 5; var q = buildQueue(); return { last: q[q.length-1], bossCount: q.filter(function(k){ return k==='boss'; }).length }; })()", context);
  assert('BOSS 关：队列末尾追加首领，且全场只有 1 只', q5.last === 'boss' && q5.bossCount === 1, JSON.stringify(q5));
  const q4 = vm.runInContext("(function(){ level = 4; var q = buildQueue(); var head = q.slice(0, 8); return { elite: head.filter(function(k){ return k==='armor' || k==='power'; }).length, hasBoss: q.indexOf('boss') >= 0 }; })()", context);
  assert('精英关：队列前段插入 3 只精英，且无 BOSS', q4.elite === 3 && q4.hasBoss === false, JSON.stringify(q4));

  // 关卡主题：5 个档位对应 5 种地貌并循环
  const th = vm.runInContext("(function(){ return [1,6,11,16,21,26].map(function(l){ return themeForLevel(l).name; }); })()", context);
  assert('关卡主题：每 5 关换一种地貌并循环（草原→沙漠→雪原→沼泽→钢铁→草原）', th.join(',') === '草原,沙漠,雪原,沼泽,钢铁,草原', JSON.stringify(th));

  // 首领阵亡必掉双道具
  const bd = vm.runInContext("(function(){ level = 5; items = []; var b = makeTank(3,3,0,'boss',{}); b.hp = 1; damageTank(b, 1, 'test'); return { dead: b.dead, dropped: items.length, score: b.score }; })()", context);
  assert('首领阵亡：掉落 2 个道具（force 越过同屏 3 上限），得分 2000', bd.dead === true && bd.dropped === 2 && bd.score === 2000, JSON.stringify(bd));

  // 音量总线 / BGM：无 AudioContext 时必须全部是安全空操作（Node 测试环境）
  const av = vm.runInContext("(function(){ var o = {}; o.actx = !!actx; o.bus = masterGain; setVolume('master', 2); o.clampHi = VOL.master; setVolume('master', -1); o.clampLo = VOL.master; setVolume('sfx', 0.25); o.sfx = VOL.sfx; setVolume('bogus', 0.5); o.ignored = (VOL.bogus === undefined); syncBgm(); o.bgmName = bgmName; setBgmOn(false); o.off = bgmOn; setBgmOn(true); o.on = bgmOn; applyVolumes(); o.ok = true; return o; })()", context);
  assert('音量总线：无 AudioContext 时不报错且总线未创建', av.actx === false && av.bus === null && av.ok === true, JSON.stringify(av));
  assert('音量总线：setVolume 越界夹到 0~1、未知总线名被忽略', av.clampHi === 1 && av.clampLo === 0 && av.sfx === 0.25 && av.ignored === true, JSON.stringify(av));
  assert('BGM：无 AudioContext 时 syncBgm 不启动音乐，开关可切换', av.bgmName === null && av.off === false && av.on === true, JSON.stringify(av));

  // BGM 谱面完整性：曲目齐备、所有音符名都在 NOTE 表内（避免出现静音轨道）
  const mus = vm.runInContext("(function(){ var bad = []; for (var k in BGM){ [BGM[k].lead, BGM[k].bass].forEach(function(seq){ seq.split(' ').forEach(function(n){ if (n === '.' || n === '-') return; if (!NOTE[n]) bad.push(k + ':' + n); }); }); } return { tracks: Object.keys(BGM), bad: bad }; })()", context);
  assert('BGM 谱面：title / battle 齐备且全部音符名有效', mus.tracks.length === 2 && mus.tracks.indexOf('title') >= 0 && mus.tracks.indexOf('battle') >= 0 && mus.bad.length === 0, JSON.stringify(mus));

  // 快照瘦身：首帧全量地图，之后只发变化格子；实体改用定长数组
  const slim = vm.runInContext("(function(){ netMode='host'; player2=null; startGame(); var s1 = serializeSnapshot(); var h1 = JSON.stringify(s1).length; var hit = null; for (var r = 1; r < ROWS-1 && !hit; r++) for (var c = 1; c < COLS-1; c++){ if (map[r][c] === BRICK){ hit = [r,c]; break; } } setTile(hit[0], hit[1], EMPTY); var s2 = serializeSnapshot(); var h2 = JSON.stringify(s2).length; return { firstFull: !!s1.m, firstNoDelta: s1.md === undefined, secondNoFull: s2.m === undefined, delta: s2.md, len1: h1, len2: h2, hit: hit, pIsArr: Array.isArray(s1.p), seq1: s1.seq, seq2: s2.seq }; })()", context);
  assert('快照协议：首帧带全量地图（m），第二帧只带增量（md）', slim.firstFull === true && slim.firstNoDelta === true && slim.secondNoFull === true, JSON.stringify(slim));
  assert('快照协议：实体改定长数组（p 为数组），seq 递增', slim.pIsArr === true && slim.seq2 === slim.seq1 + 1, JSON.stringify(slim));
  assert('快照协议：增量只含被打掉的格子', slim.delta.length === 1 && slim.delta[0][0] === slim.hit[0] && slim.delta[0][1] === slim.hit[1] && slim.delta[0][2] === 0, JSON.stringify(slim.delta));
  assert('快照瘦身：稳态快照不再携带整张地图（体积下降 > 600 字符）', slim.len2 < slim.len1 && (slim.len1 - slim.len2) > 600, JSON.stringify({ first: slim.len1, next: slim.len2 }));

  // 客方按 md 应用单格变化，并标记地形脏区（否则画面不刷新）
  const cli = vm.runInContext("(function(){ netMode='host'; startGame(); var r = 3, c = 3; map[r][c] = BRICK; var s = serializeSnapshot(); applySnapshot(s); var before = map[r][c]; for (var k in terrainDirty) delete terrainDirty[k]; terrainDirtyCount = 0; applySnapshot({ s:'playing', lvl:1, score:9, lives:3, lives2:3, fe:0, fp:0, pe:0, li:0, base:1, p: tankArr(player), p2: null, e: [], b: [], it: [], ex: [], gb: [], md: [[r, c, 0]] }); return { before: before, after: map[r][c], marked: terrainDirty[r + ',' + c] === true }; })()", context);
  assert('快照增量：客方应用 md 后地图同步且标记地形脏区', cli.before === 1 && cli.after === 0 && cli.marked === true, JSON.stringify(cli));

  // 往返一致性：位置 / 火力 / 武器 / 弹药 等字段经数组编码后不变
  const rt = vm.runInContext("(function(){ netMode='off'; player2=null; player.px = 137; player.py = 254; player.power = 3; player.gun = 'laser'; player.ammo = 7; player.movingTo = { x: 5, y: 6 }; var s = serializeSnapshot(); applySnapshot(s); return { px: player.px, py: player.py, pw: player.power, gun: player.gun, ammo: player.ammo, mt: player.movingTo, isP: player.isPlayer, pd: player.pendingDir }; })()", context);
  assert('快照往返：位置/火力/武器/弹药/移动目标一致', rt.px === 137 && rt.py === 254 && rt.pw === 3 && rt.gun === 'laser' && rt.ammo === 7 && rt.mt && rt.mt.x === 5 && rt.mt.y === 6 && rt.isP === true && rt.pd === null, JSON.stringify(rt));

  // 子弹同样用数组编码，owner.isPlayer 需还原
  const rb = vm.runInContext("(function(){ netMode='off'; bullets = [{ px:10, py:20, x:0, y:1, dir:1, ang:null, power:2, gun:'flame', owner:{isPlayer:true}, kind:null }]; var s = serializeSnapshot(); applySnapshot(s); var b = bullets[0]; return { px: b.px, py: b.py, power: b.power, gun: b.gun, ownerP: b.owner.isPlayer, arr: Array.isArray(s.b[0]) }; })()", context);
  assert('快照往返：子弹数组编码还原（含 owner.isPlayer）', rb.arr === true && rb.px === 10 && rb.py === 20 && rb.power === 2 && rb.gun === 'flame' && rb.ownerP === true, JSON.stringify(rb));

  // 破坏格子过多 → 退回全量地图，避免增量包无限增长
  const ovf = vm.runInContext("(function(){ snapFullNeeded = false; tileDelta = []; for (var i = 0; i < 210; i++) setTile(0, 0, i % 2 ? 1 : 0); return { full: snapFullNeeded, len: tileDelta.length }; })()", context);
  assert('快照增量：破坏超过 200 格时退回全量地图', ovf.full === true, JSON.stringify(ovf));

  // 延迟测量：客方回带 ack，在最近若干帧的发送时刻里反查（ack 常晚于最新帧到达）
  const rtt = vm.runInContext("(function(){ netMode = 'host'; var t0 = performance.now(); snapPing = [[5, t0 - 200], [6, t0 - 120], [7, t0 - 80]]; coopHandleMsg({ type:'input', k:0, ack:7 }); var a = coopRtt; coopHandleMsg({ type:'input', k:0, ack:6 }); var b = coopRtt; coopHandleMsg({ type:'input', k:0, ack:999 }); return { newest: a, older: b, unknownKeeps: coopRtt, keep: SNAP_PING_KEEP }; })()", context);
  assert('延迟测量：按 ack 反查发送时刻（80 / 120ms），未知 seq 不覆盖', rtt.newest === 80 && rtt.older === 120 && rtt.unknownKeeps === 120, JSON.stringify(rtt));
  assert('延迟测量：发送时刻环形缓冲有上限（16 帧 ≈ 0.8 秒窗口）', rtt.keep === 16, JSON.stringify(rtt));

  // 高关卡冒烟：BOSS 关 / 精英关连续跑帧（含地形缓存、字母道具、BOSS 血条、幕布标签）
  const smoke = vm.runInContext("(function(){ var err = null, out = {}; try { netMode = 'off'; player2 = null; startGame(); level = 5; startLevel(); enemies = [makeTank(6, 3, 2, 'boss', {invuln:0})]; enemies[0].hp = 7; enemyQueue = ['armor','power','bonus']; items = [{x:5,y:5,px:110,py:110,type:'laser',t:0,dead:false}]; for (var i = 0; i < 220; i++){ gameTime += 0.016; update(0.016); render(); syncBgm(); } out.bossTag = levelTag(); out.theme5 = levelThemeName; level = 4; startLevel(); for (var j = 0; j < 120; j++){ gameTime += 0.016; update(0.016); render(); } out.eliteTag = levelTag(); out.theme4 = levelThemeName; out.enemyCount = enemyQueue.length; } catch(e){ err = e.message + ' @ ' + (e.stack || '').split('\\n')[1]; } return { err: err, out: out }; })()", context);
  assert('高关卡冒烟：BOSS 关 + 精英关 340 帧 update/render 无异常', smoke.err === null, String(smoke.err));
  assert('高关卡冒烟：BOSS 关标签/地貌正确，精英关队列含 3 只精英', smoke.err === null && smoke.out.bossTag === 'BOSS' && smoke.out.theme5 === '草原' && smoke.out.eliteTag === '精英关' && smoke.out.theme4 === '草原' && smoke.out.enemyCount >= 3, JSON.stringify(smoke.out));

  // 生命图标应明确为坦克剪影，避免黄方块+两根竖条被误读为「老鹰脸」
  const iconCalls = vm.runInContext("(function(){ var calls = []; ctx.fillRect = function(x,y,w,h){ calls.push([x,y,w,h,ctx.fillStyle]); }; drawLifeIcon(10, 10); return calls; })()", context);
  const hasBarrel = iconCalls.some(c => c[4] === '#4A4F57' && c[0] === 18 && c[1] === 10 && c[2] === 2 && c[3] === 8);
  const hasTurret = iconCalls.some(c => c[4] === '#8A6200' && c[0] === 17 && c[1] === 17 && c[2] === 4 && c[3] === 4);
  const hasHull   = iconCalls.some(c => c[4] === '#F5C518' && c[0] === 13 && c[1] === 15 && c[2] === 12 && c[3] === 9);
  assert('生命图标：包含炮管 + 炮塔 + 车体，明确是坦克而非老鹰脸', hasBarrel && hasTurret && hasHull, JSON.stringify({barrel:hasBarrel,turret:hasTurret,hull:hasHull}));

  /* ---- 联机状态横幅 ----
   * 掉线 / 重连 / 等待房主这类状态原先只写进联机弹窗的 #coop-status，而弹窗在
   * 开局后就被关掉了：手机端客方画面是纯快照驱动的，房主一掉线画面立即冻住，
   * 却没有任何可见提示 —— 表现就是「卡死了、摇杆也没反应」。这条横幅必须留在画面上。 */
  const banner = vm.runInContext(`(function(){
    var el = document.getElementById('net-banner');
    var out = {};
    netMode = 'guest';
    coopHandleMsg({ type:'peer', event:'dropped' });
    out.dropped = el.textContent;
    coopDropped = false;
    coopHandleMsg({ type:'state', snap: serializeSnapshot() });   // 快照正常到达 → 清横幅
    out.cleared = el.textContent;
    coopHandleMsg({ type:'net', event:'reconnecting', attempt: 3 });
    out.reconnecting = el.textContent;
    coopHandleMsg({ type:'net', event:'reconnect_failed' });
    out.failed = el.textContent;
    coopHandleMsg({ type:'room', action:'joined' });
    out.waiting = el.textContent;
    coopReset();
    out.afterReset = el.textContent;
    return out;
  })()`, context);
  assert('联机横幅：房主掉线时画面可见（不再只写在已关闭的弹窗里）',
    /房主掉线/.test(banner.dropped), JSON.stringify(banner.dropped));
  assert('联机横幅：快照正常到达后自动清除', banner.cleared === '', JSON.stringify(banner.cleared));
  assert('联机横幅：等待房主 / 重连中 / 重连失败均有文案',
    /等待房主/.test(banner.waiting) && /正在重连/.test(banner.reconnecting) && /重连失败/.test(banner.failed),
    JSON.stringify({ waiting: banner.waiting, reconnecting: banner.reconnecting, failed: banner.failed }));
  assert('联机横幅：主动断开后清空', banner.afterReset === '', JSON.stringify(banner.afterReset));
}

/* ---------- 单元：net.js 重连状态机（用假 WebSocket + 可控定时器） ---------- */
function netUnit() {
  console.log('\n=== 单元：net.js 重连状态机 ===');
  const timers = [];
  let lastWS = null;
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; lastWS = this; }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const store = {};
  const sandbox = {
    console, WebSocket: FakeWS,
    location: { protocol: 'http:', host: 'localhost:8080' },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (id) timers[id - 1] = null; },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'net.js'), 'utf8'), ctx, { filename: 'net.js' });
  const flush = () => { timers.splice(0).forEach(t => { if (t) t.fn(); }); };

  const seen = [];
  ctx.Net.onMessage(m => seen.push(m));
  let opened = 0;
  ctx.Net.onOpen(() => { opened++; ctx.Net.send({ type: 'room', action: 'create' }); });

  ctx.Net.connect('host');
  assert('connect 后建立 WebSocket 连接', !!lastWS);
  assert('默认中继地址为同源 /ws', lastWS.url === 'ws://localhost:8080/ws', lastWS.url);
  lastWS.readyState = 1; lastWS.onopen();
  assert('首次连接触发 onOpen（发送 create）', opened === 1 && lastWS.sent.some(m => m.action === 'create'));

  lastWS.onmessage({ data: JSON.stringify({ type: 'room', action: 'created', code: 'ABCD', token: 'TK1' }) });
  const ws1 = lastWS;
  ws1.readyState = 3; ws1.onclose();
  assert('掉线上报 net.offline', seen.some(m => m.type === 'net' && m.event === 'offline'));
  assert('掉线后进入 net.reconnecting', seen.some(m => m.type === 'net' && m.event === 'reconnecting'));

  flush();                                   // 触发退避重试 -> 新建连接
  assert('重试后建立新连接', lastWS !== ws1);
  lastWS.readyState = 1; lastWS.onopen();
  const rejoin = lastWS.sent.find(m => m.action === 'rejoin');
  assert('重连时带房间号与令牌发起 rejoin', !!rejoin && rejoin.code === 'ABCD' && rejoin.token === 'TK1', JSON.stringify(rejoin));

  lastWS.onmessage({ data: JSON.stringify({ type: 'room', action: 'rejoined', code: 'ABCD', role: 'host' }) });
  assert('rejoin 成功上报 net.reconnected', seen.some(m => m.type === 'net' && m.event === 'reconnected'));

  const before = seen.length;
  ctx.Net.disconnect();
  assert('主动 disconnect 不触发重连', !seen.slice(before).some(m => m.type === 'net' && m.event === 'offline'));

  /* 中继地址可配置：页面托管在静态站点、游戏服务在另一台机器时依赖它 */
  const nr = ctx.Net._normalizeRelay;
  assert('relay 规范化：裸 host:port 自动补协议与 /ws',
    nr('relay.example.com:9000') === 'ws://relay.example.com:9000/ws', nr('relay.example.com:9000'));
  assert('relay 规范化：保留显式 wss 与自定义路径',
    nr('wss://relay.example.com/relay') === 'wss://relay.example.com/relay', nr('wss://relay.example.com/relay'));
  assert('relay 规范化：末尾裸斜杠补成 /ws',
    nr('192.168.1.7:8080/') === 'ws://192.168.1.7:8080/ws', nr('192.168.1.7:8080/'));
  assert('relay 规范化：非 ws/wss 协议被拒绝（返回空串）',
    nr('http://evil.example/x') === '' && nr('https://evil.example') === '', nr('http://evil.example/x'));
  assert('relay 规范化：空串与纯空白返回空串', nr('') === '' && nr('   ') === '', '_');

  // https 页面必须自动改用 wss，否则浏览器按混合内容直接拒绝连接
  sandbox.location.protocol = 'https:';
  assert('relay 规范化：https 页面裸 host 自动补 wss',
    nr('relay.example.com:9000') === 'wss://relay.example.com:9000/ws', nr('relay.example.com:9000'));
  sandbox.location.protocol = 'http:';

  assert('setRelay 写入后 _url 走自定义中继',
    ctx.Net.setRelay('relay.local:9000') === 'ws://relay.local:9000/ws' &&
    ctx.Net.relayUrl() === 'ws://relay.local:9000/ws', ctx.Net.relayUrl());
  assert('setRelay 传空串即清除，回到同源 /ws',
    ctx.Net.setRelay('') === '' && ctx.Net.relayUrl() === 'ws://localhost:8080/ws', ctx.Net.relayUrl());

  // ?relay= 查询参数优先于 localStorage 记住的地址
  ctx.Net.setRelay('stored.local:1111');
  sandbox.location.search = '?relay=' + encodeURIComponent('wss://from-query.example/ws');
  assert('?relay= 查询参数优先于已记住的地址',
    ctx.Net.relayUrl() === 'wss://from-query.example/ws', ctx.Net.relayUrl());
  sandbox.location.search = '?relay=' + encodeURIComponent('http://bad.example');
  assert('?relay= 非法协议时回退到已记住的地址',
    ctx.Net.relayUrl() === 'ws://stored.local:1111/ws', ctx.Net.relayUrl());
  sandbox.location.search = '';
  ctx.Net.setRelay('');
}

(async () => {
  staticChecks();
  await cliChecks();
  await publicUrlCheck();
  await integration();
  unit();
  netUnit();
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  console.log('\n結果: ' + pass + '/' + results.length + ' 通過' + (fail ? '（' + fail + ' 失败）' : ''));
  process.exit(fail ? 1 : 0);
})();
