/* =========================================================
 * 双人合作：网络层集成测试 + 同步逻辑单元测试
 *   - 集成：启动 server.js，验证 握手/创建/加入/输入中继/快照中继/掉线
 *   - 单元：快照往返含 player2、输入打包对称、玩家集合/命数、友伤关闭
 * 运行：node tests/net_test.js
 * ========================================================= */
'use strict';
const fs = require('fs');
const vm = require('vm');
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
function startServer() {
  return new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
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
  assert('快照往返保留 lives2', round.before.lives2 === 3 && round.after.lives2 === 3, JSON.stringify(round));

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
  assert('复活保留火力等级（power=2）', respawn.pow === 2 && respawn.dead === false, JSON.stringify(respawn));

  // 无障碍：减少动效把高倍闪烁限制到 <=3Hz（WCAG 2.3.1）
  const rm = vm.runInContext("(function(){ function starts(hz, reduce, dur){ reduceMotion = reduce; var c = 0, prev = null; for (var t = 0; t < dur; t += 0.005){ gameTime = t; var on = flashOn(hz); if (prev === false && on) c++; prev = on; } return c; } var normal = starts(10, false, 2); var reduced = starts(10, true, 2); reduceMotion = false; return { normal: normal, reduced: reduced, cap: FLASH_HZ_MAX }; })()", context);
  assert('减少动效：正常时 10Hz 闪烁每秒亮起约 5 次', rm.normal >= 9 && rm.normal <= 11, JSON.stringify(rm));
  assert('减少动效：开启后闪烁上限 ≤3Hz（2 秒内亮起 ≤4 次）', rm.reduced >= 2 && rm.reduced <= 4 && rm.cap === 3, JSON.stringify(rm));

  // 高分屏：按 devicePixelRatio 放大画布背板（逻辑坐标仍是 680x520）
  const hp = vm.runInContext("(function(){ var out = {}; window.devicePixelRatio = 2; setupHiDPI(); out.dpr = DPR; out.cw = canvas.width; out.ch = canvas.height; window.devicePixelRatio = undefined; setupHiDPI(); out.restore = DPR; return out; })()", context);
  assert('高分屏：DPR=2 时背板放大为 1360x1040', hp.dpr === 2 && hp.cw === 1360 && hp.ch === 1040, JSON.stringify(hp));
  assert('高分屏：无 DPR 时回退为 1（680x520）', hp.restore === 1, JSON.stringify(hp));
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
  const sandbox = {
    console, WebSocket: FakeWS,
    location: { protocol: 'http:', host: 'localhost:8080' },
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
}

(async () => {
  await integration();
  unit();
  netUnit();
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  console.log('\n結果: ' + pass + '/' + results.length + ' 通過' + (fail ? '（' + fail + ' 失败）' : ''));
  process.exit(fail ? 1 : 0);
})();
