/* 双人联机端到端探针：真 server.js + 真 WebSocket + 两端各跑一份真 game.js。
 *
 * 为什么需要它：tests/net_test.js 验证的是**协议转发**（谁发给谁、带没带 from 标签），
 * 覆盖不到「客方按摇杆 → 房主侧玩家2 真的移动 → 快照回显到客方屏幕」这条**行为链**。
 * 联机「卡住 / 没反应」这类问题恰恰只在这种跨端口径下才复现得出来。
 *
 * 覆盖：
 *   - 建房 / 加入 / peer.joined 自动开局
 *   - 客方首帧快照 → state=playing、body.idle 解除（摇杆可见）
 *   - 客方输入 → 房主侧玩家2 位移 → 客方收到的快照位置一致
 *   - 松手即停、暂停双向同步
 *   - 房主过关自动继续 → 客方看到过关界面并跟随进入下一关
 *
 * 运行：node tools/e2e_coop.js     （占用 8399 端口，跑完自动退出）
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8399;
const noop = () => {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 起服务器 ---------- */
function startServer(){
  return new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), WS_PING_MS: '30000' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const on = d => { out += d.toString(); if (out.includes('已启动')) resolve(srv); };
    srv.stdout.on('data', on); srv.stderr.on('data', on);
    srv.on('error', reject);
    setTimeout(() => resolve(srv), 1500);
  });
}

/* ---------- 跑真 game.js 的 vm 沙箱 ---------- */
const BOOT = `
FEED      = function(m){ coopHandleMsg(m); };
TICK      = function(ms){ vnow += ms; RAF_CB(vnow); };
OPEN      = function(){ if (__netOpen) __netOpen(); };
SET_ROLE  = function(role, code){ netMode = role; if (code) coopRoomCode = code; };
SET_KEYS2 = function(o){ keys2 = o; };
PAUSE     = function(){ togglePause(); };
FORCE_CLEAR = function(){ enemyQueue.length = 0; enemies.length = 0; };
GET = function(){ return {
  state: state, paused: paused, netMode: netMode, level: level,
  idle: document.body.classList.contains('idle'),
  overlay: document.getElementById('coop-overlay').classList.contains('show'),
  roomCode: coopRoomCode, snapSeq: applySnapshot.lastSeq,
  p1: player ? { px: player.px, py: player.py, x: player.x, y: player.y } : null,
  p2: player2 ? { px: player2.px, py: player2.py, x: player2.x, y: player2.y,
                  gun: player2.gun, ammo: player2.ammo, power: player2.power } : null,
  keys2: JSON.parse(JSON.stringify(keys2)),
  p2bullets: bullets.filter(function(b){ return b.owner === player2 || (b.owner && b.owner.tag === 2); }).length,
  pred: predBullets.length,
  continues: continuesLeft,
}; };
SANDBOX_OUT = [];
`;

function makeSandbox(name){
  const opStat = { calls: 0 };
  const ctxStub = new Proxy({}, {
    get(t,p){ if (p === '__opStat') return opStat; if (p in t) return t[p]; return function(){ opStat.calls++; }; },
    set(t,p,v){ t[p]=v; return true; },
  });
  const closet = () => { const s = new Set(); return {
    add:c=>s.add(c), remove:c=>s.delete(c),
    toggle:(c,on)=>{ if(on===undefined){ s.has(c)?s.delete(c):s.add(c); } else { on?s.add(c):s.delete(c); } },
    contains:c=>s.has(c) }; };
  const EL = {};
  const mkEl = id => { const h={}; return { id, __h:h,
    addEventListener:(t,f)=>{(h[t]=h[t]||[]).push(f)}, removeEventListener:noop,
    classList: closet(), dataset:{}, style:{}, textContent:'', disabled:false, value:'',
    getContext:()=>ctxStub,
    getBoundingClientRect:()=>({left:0,top:0,width:128,height:128,right:128,bottom:128}),
    setPointerCapture:noop, releasePointerCapture:noop,
    requestFullscreen:noop, webkitRequestFullscreen:noop,
    _fire(t,ev){ (h[t]||[]).forEach(f=>f(Object.assign({preventDefault:noop,pointerId:1},ev))); } }; };
  const TBTN = mkEl('pad-fire'); TBTN.dataset.k='Space'; EL['pad-fire']=TBTN;

  const sandbox = {
    console, vnow: 0, RAF_CB: null,
    Image: class { constructor(){this.width=28;this.height=36;} set src(v){this._src=v; if(this.onload)this.onload();} get src(){return this._src;} },
    Audio: class { constructor(s){this.src=s;} play(){return Promise.resolve();} },
    matchMedia: q => ({ matches: q.indexOf('coarse') >= 0 }),
    Net: {
      isOpen: () => true, bufferedAmount: () => 0,
      send: m => { sandbox.SANDBOX_OUT.push(m); },
      onOpen: cb => { sandbox.__netOpen = cb; },
      onMessage: noop, connect: noop, disconnect: noop,
      relayUrl: () => '', setRelay: () => '',
    },
    window: { addEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined },
    document: {
      getElementById: id => (EL[id] || (EL[id] = mkEl(id))),
      querySelectorAll: sel => (sel === '.tbtn' ? [TBTN] : []),
      addEventListener: noop,
      createElement: () => ({ width:0, height:0, getContext: () => ctxStub }),
      body: mkEl('body'), fullscreenElement: null, hidden: false,
    },
    localStorage: { getItem: () => '0', setItem: noop, removeItem: noop },
    performance: { now: () => sandbox.vnow },
    requestAnimationFrame: cb => { sandbox.RAF_CB = cb; return 1; },
    setTimeout: noop,
    fetch: () => Promise.reject(new Error('no net')),
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT,'assets/sounds.js'),'utf8'), context, { filename:'sounds.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT,'game.js'),'utf8'), context, { filename:'game.js' });
  vm.runInContext(BOOT, context, { filename:'boot.js' });
  return {
    name, context, sandbox, msgs: [],
    flush(ws){ const a = sandbox.SANDBOX_OUT; while (a.length){ const m = a.shift(); try { ws.send(JSON.stringify(m)); } catch (e) {} } },
    feed(){ while (this.msgs.length){ const m = this.msgs.shift(); if (this.log) this.log(m); context.FEED(m); } },
    tick(ms){ context.TICK(ms); },
    get(){ return context.GET(); },
    setRole(r,c){ context.SET_ROLE(r,c); },
    open(){ context.OPEN(); },
    setKeys2(o){ context.SET_KEYS2(o); },
    pause(){ context.PAUSE(); },
    forceClear(){ context.FORCE_CLEAR(); },
  };
}

function connect(port, sb){
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket('ws://127.0.0.1:' + port + '/ws');
    ws.onmessage = ev => { try { sb.msgs.push(JSON.parse(ev.data)); } catch (e) {} };
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error'));
  });
}

function waitMsg(sb, pred, timeout = 2000){
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const i = sb.msgs.findIndex(pred);
      if (i >= 0) return resolve(sb.msgs.splice(i,1)[0]);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout waiting msg'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

(async function main(){
  const R = [];
  const A = (n, ok, ex) => { R.push({n, ok:!!ok}); console.log((ok?'PASS  ':'FAIL  ')+n+(ex?'   ['+ex+']':'')); };

  const srv = await startServer();
  if (!globalThis.WebSocket){ console.log('无 WebSocket'); srv.kill(); return; }
  const host = makeSandbox('host'), guest = makeSandbox('guest');
  let hWS, gWS;

  try {
    /* 1. 房主创建房间 */
    hWS = await connect(PORT, host);
    host.setRole('host');
    host.open();                       // coopInit 的 onOpen → Net.send({room create})
    host.flush(hWS);
    const created = await waitMsg(host, m => m.type === 'room' && m.action === 'created');
    host.feed();
    A('E1 房主创建房间并拿到 4 位房间号', created && (created.code||'').length === 4, 'code=' + created.code);

    /* 2. 客方加入 */
    gWS = await connect(PORT, guest);
    guest.setRole('guest', created.code);
    guest.open();
    guest.flush(gWS);
    await sleep(80);
    host.feed(); guest.feed();

    let h = host.get(), g = guest.get();
    A('E2 房主收到 peer.joined 后自动开局', h.state === 'playing' && !!h.p2,
      'state=' + h.state + ' p2=' + (h.p2 ? 'yes' : 'no'));
    A('E3 房主侧联机弹窗已关闭', h.overlay === false, 'overlay=' + h.overlay);

    /* 3. 循环：两端跑真 loop，真快照 / 真输入经真 WebSocket 互通 */
    const stat = { inK: [], pauseV: [], rows: [] };
    host.log = m => { if (m.type === 'input') stat.inK.push(m.k); if (m.type === 'pause') stat.pauseV.push(m.v); };
    async function run(frames){
      for (let i = 0; i < frames; i++){
        host.tick(16.7); guest.tick(16.7);
        host.flush(hWS); guest.flush(gWS);
        await sleep(6);
        host.feed(); guest.feed();
      }
    }
    await run(45);

    g = guest.get(); h = host.get();
    A('E4 客方收到首帧快照 → state=playing 且摇杆解除隐藏（idle=false）',
      g.state === 'playing' && g.idle === false, 'state=' + g.state + ' idle=' + g.idle);
    A('E5 客方拿到自己的坦克 player2（与房主坦克分处两地）',
      !!g.p2 && !!g.p1 && (g.p2.px !== g.p1.px || g.p2.py !== g.p1.py),
      'p1=' + JSON.stringify(g.p1 && [g.p1.px,g.p1.py]) + ' p2=' + JSON.stringify(g.p2 && [g.p2.px,g.p2.py]));

    /* 4. 客方按住「右」 */
    const before = host.get().p2;
    guest.setKeys2({ ArrowRight: true });
    await run(60);
    const after = host.get().p2;
    A('E6 客方摇杆向右 → 房主侧玩家2 真的移动',
      before && after && after.px > before.px,
      'host p2.px ' + before.px + ' -> ' + after.px +
      ' | 收到的输入包 k=' + JSON.stringify(stat.inK.slice(0, 24)) + ' 共' + stat.inK.length + '个');
    const gg = guest.get();
    A('E7 客方画面上的玩家2 与房主保持一致（本地预测 + 快照对账）',
      !!gg.p2 && Math.abs(gg.p2.px - after.px) <= 40,
      'guest p2.px=' + (gg.p2 && gg.p2.px) + ' host p2.px=' + after.px + ' seq=' + gg.snapSeq);

    /* 5. 客方松手 */
    guest.setKeys2({});
    await run(20);
    const s1 = host.get().p2;
    await run(16);
    const s2 = host.get().p2;
    A('E8 客方松手 → 房主侧玩家2 停住', Math.abs(s2.px - s1.px) + Math.abs(s2.py - s1.py) <= 20,
      '(' + s1.px + ',' + s1.py + ') -> (' + s2.px + ',' + s2.py + ')');

    /* 6. 暂停同步 */
    guest.pause();                       // 客方按暂停 → 发请求
    guest.flush(gWS);
    await sleep(60);
    host.feed();                         // 房主收到请求 → setPaused(true,true) → 广播
    host.flush(hWS);
    await sleep(60);
    guest.feed();
    const hp = host.get(), gp = guest.get();
    A('E9 客方按暂停 → 两边同时暂停', hp.paused === true && gp.paused === true,
      'host=' + hp.paused + ' guest=' + gp.paused + ' host收到pause=' + JSON.stringify(stat.pauseV));

    /* 7. 过关自动继续：房主清光敌人 → clear → 倒计时结束自动进下一关 → 客方跟随。
     * v1.6.0 的新行为，也是最容易两边关卡错位的地方，必须跨端验证。 */
    host.pause();                        // 先取消暂停（E9 把两边都停住了）
    host.flush(hWS);
    await sleep(60);
    guest.feed();
    const hResumed = host.get().paused === false;
    host.forceClear();
    await run(4);
    const hClear = host.get(), gClear = guest.get();
    A('E10 房主清光敌人 → 房主进入 clear，且客方也看到过关界面',
      hResumed && hClear.state === 'clear' && gClear.state === 'clear',
      'resumed=' + hResumed + ' host=' + hClear.state + ' guest=' + gClear.state);

    await run(300);                      // 4 秒倒计时（≈240 帧）后应自动进入下一关
    const hNext = host.get(), gNext = guest.get();
    A('E11 过关自动继续：房主自动进入下一关（难度-关号推进）',
      hNext.state === 'playing' && hNext.level === hClear.level + 1,
      'lvl ' + hClear.level + ' -> ' + hNext.level + ' state=' + hNext.state);
    A('E12 客方关卡跟随房主（跨端一致，不会各自推进）',
      gNext.level === hNext.level && gNext.state === 'playing',
      'host lvl=' + hNext.level + ' guest lvl=' + gNext.level + ' guest state=' + gNext.state);

    /* 8. 本地预测的长期行为：不能跑飞，也不能在没输入时自己乱动 */
    guest.setKeys2({ ArrowRight: true });
    await run(40);
    const hPred = host.get().p2, gPred = guest.get().p2;
    A('E13 持续输入 40 帧后，客方本地预测仍紧贴房主权威位置（预测不会跑飞）',
      !!hPred && !!gPred &&
      Math.abs(gPred.px - hPred.px) <= 24 && Math.abs(gPred.py - hPred.py) <= 24,
      'host=(' + hPred.px + ',' + hPred.py + ') guest=(' + gPred.px + ',' + gPred.py + ')');

    guest.setKeys2({});
    for (let i = 0; i < 8; i++) guest.tick(16.7);     // 先让「松手对格心」收敛完
    const q1 = guest.get().p2;
    for (let i = 0; i < 20; i++) guest.tick(16.7);    // 只跑客方、零快照
    const q2 = guest.get().p2;
    A('E14 无输入时本地预测不产生位移（松手收敛到格心后即静止）',
      q1.px === q2.px && q1.py === q2.py,
      '(' + q1.px + ',' + q1.py + ') -> (' + q2.px + ',' + q2.py + ')');

    /* 9. 客方开火本地预测（v1.6.2）：按下开火 → 客方画面立刻出现曳光弹（不等快照），
     * 同时经房主权威真的发射出子弹 —— 联机开火必须真的生效，不能只是本地特效。 */
    guest.setKeys2({ Space: true });
    for (let i = 0; i < 4; i++) guest.tick(16.7);   // 越过本地冷却（≤0.05s）后才允许首发
    const gShot = guest.get();
    A('E15 客方按开火 → 画面上立刻出现本地曳光弹（不必等房主快照）',
      gShot.pred >= 1, 'pred=' + gShot.pred);

    let maxP2 = 0;
    for (let i = 0; i < 45; i++){
      host.tick(16.7); guest.tick(16.7);
      host.flush(hWS); guest.flush(gWS);
      await sleep(6);
      host.feed(); guest.feed();
      maxP2 = Math.max(maxP2, host.get().p2bullets);
    }
    A('E16 客方开火经房主权威真的发射出子弹（不是只有本地特效）',
      maxP2 >= 1, '房主侧 P2 子弹峰值=' + maxP2);

    guest.setKeys2({});
    await run(20);
    A('E17 客方松手后曳光弹归零（本地预测不会自己持续开火 / 不留残影）',
      guest.get().pred === 0, 'pred=' + guest.get().pred);

    /* 9. v1.6.9 续关：房主死亡后，客方点「继续本关」→ 房主原地重开同一关（关卡不倒退）。
     *    这是联机里唯一一条「客方发起、房主执行、再靠快照同步回来」的状态迁移，最容易出岔。 */
    const lvlBefore = host.get().level;
    const leftBefore = host.get().continues;
    vm.runInContext('destroyBase()', host.context);
    A('E18 基地被毁 → 房主进入结束画面', host.get().state === 'over', 'state=' + host.get().state);

    await run(10);
    A('E19 客方也看到结束画面（纯快照驱动，不各自为政）',
      guest.get().state === 'over', 'guest state=' + guest.get().state);

    await run(60);      // 越过 startLockT 的 0.8 秒误触保护
    vm.runInContext('requestContinue()', guest.context);
    await run(12);
    const hC = host.get(), gC = guest.get();
    A('E20 客方请求续关 → 房主原地重开同一关（关卡不倒退），客方同步跟上',
      hC.state === 'playing' && hC.level === lvlBefore && gC.state === 'playing' && gC.level === lvlBefore,
      'lvl ' + lvlBefore + '->' + hC.level + ' host=' + hC.state + ' guest=' + gC.level + '/' + gC.state);
    A('E21 续关只消耗 1 次配额，且客方看到同一个剩余次数',
      leftBefore - hC.continues === 1 && gC.continues === hC.continues,
      'host ' + leftBefore + '->' + hC.continues + ' guest=' + gC.continues);

  } catch (e) {
    A('端到端执行无异常', false, (e && e.message) || String(e));
  } finally {
    try { hWS && hWS.close(); } catch (e) {}
    try { gWS && gWS.close(); } catch (e) {}
    srv.kill();
  }

  const fails = R.filter(r => !r.ok).length;
  console.log('\n---- 端到端：' + (R.length - fails) + '/' + R.length + ' 通过 ----');
  process.exit(fails ? 1 : 0);
})();
