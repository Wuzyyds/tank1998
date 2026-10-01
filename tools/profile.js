/* 无头性能剖析器：量化每帧 canvas 调用数与 JS 耗时。
 *
 * 用途：游戏是纯 Canvas 2D，真实光栅成本无法在 Node 里测，
 * 但「每帧提交多少次绘制指令」是稳定且可复现的成本代理指标，
 * 加上 update/render 的真实 JS 执行时间，足以定位热路径并验证优化收益。
 *
 * 运行： node tools/profile.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const noop = () => {};

/* ---------- 计数的 2D 上下文：记录每个方法的调用次数 ---------- */
let counts = Object.create(null);
const resetCounts = () => { counts = Object.create(null); };
const totalOps = () => { let n = 0; for (const k in counts) n += counts[k]; return n; };
const topOps = (limit) => Object.entries(counts)
  .sort((a, b) => b[1] - a[1]).slice(0, limit);

/* 归因模式：按「调用 ctx 的那个 game.js 函数」分桶，精确定位成本来源 */
let attributing = false;
let byFn = Object.create(null);
const GAME_RE = /at (?:(?<fn>[\w$.<>]+) )?\((.*game\.js):(\d+):\d+\)/;
function attribute() {
  if (!attributing) return '?';
  const stack = new Error().stack || '';
  const lines = stack.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const m = GAME_RE.exec(lines[i]);
    if (m) {
      const fn = m.groups.fn || '<anon>';
      if (fn === 'px' || fn === 'setFill') continue;   // px 是所有绘制的公共出口，归到它的调用方
      return fn;
    }
  }
  return '<outside>';
}

const baseCtx = {};
const ctxStub = new Proxy(baseCtx, {
  get(t, p) {
    if (typeof p !== 'string') return undefined;
    if (p in t) return t[p];
    return function () {
      counts[p] = (counts[p] || 0) + 1;
      if (attributing) { const f = attribute(); byFn[f] = (byFn[f] || 0) + 1; }
    };
  },
  set(t, p, v) {
    counts['=' + String(p)] = (counts['=' + String(p)] || 0) + 1;
    if (attributing) { const f = attribute(); byFn[f] = (byFn[f] || 0) + 1; }
    t[p] = v; return true;
  },
});

const mkEl = (id) => ({
  id, __h: {},
  addEventListener: noop, removeEventListener: noop,
  classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
  dataset: {}, style: {}, textContent: '', disabled: false, value: '0',
  getContext: () => ctxStub,
  requestFullscreen: noop, webkitRequestFullscreen: noop,
});
const EL_CACHE = {};

class ImageStub {
  constructor() { this.width = 28; this.height = 36; this.onload = null; this.onerror = null; }
  set src(v) { this._src = v; if (this.onload) this.onload(); }
  get src() { return this._src; }
}
class AudioStub { constructor(src) { this.src = src; this.currentTime = 0; } play() { return Promise.resolve(); } }

const sandbox = {
  console, TESTOUT: [], vnow: 0, RAF_CB: null,
  Image: ImageStub, Audio: AudioStub,
  window: { addEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, devicePixelRatio: 2 },
  document: {
    getElementById: id => (EL_CACHE[id] || (EL_CACHE[id] = mkEl(id))),
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
    body: mkEl('body'), fullscreenElement: null, hidden: false,
  },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  performance: { now: () => sandbox.vnow },
  requestAnimationFrame: cb => { sandbox.RAF_CB = cb; return 1; },
  setTimeout: noop, clearTimeout: noop,
  fetch: () => Promise.reject(new Error('no network')),
};
sandbox.globalThis = sandbox;
sandbox.window.document = sandbox.document;

const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/sounds.js'), 'utf8'), context, { filename: 'sounds.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, { filename: 'game.js' });

/* 场景搭建脚本（必须跑在 vm 作用域内，才能访问 game.js 的顶层 let 变量） */
function setup(src) { vm.runInContext(src, context, { filename: 'scene.js' }); }

/* 测量 n 帧：返回 JS 耗时与绘制指令数 */
function measure(n) {
  resetCounts();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { sandbox.vnow += 16.7; sandbox.RAF_CB(sandbox.vnow); }
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6 / n, ops: totalOps() / n, snapshot: { ...counts } };
}

const scenarios = [];

/* S1 基线：第 1 关正常游玩 */
setup(`
startGame();
for (let i = 0; i < 220; i++){ vnow += 16.7; RAF_CB(vnow); }   // 跳过幕布
for (let i = 0; i < 300; i++){ vnow += 16.7; RAF_CB(vnow); }   // 自然生成敌人
`);
scenarios.push(['S1 第1关·自然', measure(240)]);

/* S2 后期关：第 20 关 BOSS 档（王牌 tier）自然节奏 */
setup(`
level = 20; startLevel();
for (let i = 0; i < 220; i++){ vnow += 16.7; RAF_CB(vnow); }
for (let i = 0; i < 600; i++){ vnow += 16.7; RAF_CB(vnow); }
`);
scenarios.push(['S2 第20关·BOSS', measure(240)]);

/* S3 极端压力：30 敌 + 80 弹 + 爆炸，逼近上限 */
setup(`
level = 20; startLevel();
for (let i = 0; i < 220; i++){ vnow += 16.7; RAF_CB(vnow); }
for (let k = 0; k < 30; k++) enemies.push(makeTank(SPAWN_POINTS[k % 3].x, SPAWN_POINTS[k % 3].y, 2, k % 5 === 0 ? 'boss' : 'basic', { invuln: 0 }));
for (let k = 0; k < 80; k++) fireBullet(player);
for (let k = 0; k < 40; k++) addExplosion(120 + k * 8, 200 + (k % 5) * 20, 'big');
state = 'playing'; baseAlive = true;
`);
scenarios.push(['S3 极端压力', measure(240)]);

/* ---------- 输出 ---------- */
console.log('\n=== TANK 1998 性能剖析（每帧）===');
console.log('（ms/frame = update+render 的真实 JS 时间；ops = 提交给 canvas 的绘制指令数）\n');
const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(pad('场景', 18) + pad('ms/frame', 10) + pad('ops/frame', 12) + 'fillRect  fillStyle  drawImage  save  fillText');
for (const [label, r] of scenarios) {
  const c = r.snapshot;
  console.log(
    pad(label, 18) +
    pad(r.ms.toFixed(2), 10) +
    pad(r.ops.toFixed(0), 12) +
    pad(c.fillRect || 0, 10) + pad(c['=fillStyle'] || 0, 11) + pad(c.drawImage || 0, 11) +
    pad(c.save || 0, 6) + pad(c.fillText || 0, 9)
  );
}

const last = scenarios[scenarios.length - 1][1];
console.log('\n--- S3 绘制指令 TOP 12 ---');
for (const [k, v] of topOps(12)) console.log(pad(k, 20) + (v / 240).toFixed(1) + ' /帧');

const ent = vm.runInContext('JSON.stringify({enemies:enemies.length, bullets:bullets.length, items:items.length, ex:explosions.length})', context);
console.log('\n--- 当前实体数（S3 结束时）---\n' + ent);

/* 地形普查：水/树每帧逐格重绘，是 fillRect 的主要来源 */
const census = vm.runInContext(`(() => {
  const names = {};
  names[EMPTY]='空地'; names[BRICK]='砖'; names[STEEL]='钢'; names[WATER]='水';
  names[TREE]='树'; names[BASE]='基地'; names[DESERT]='沙'; names[SWAMP]='沼'; names[SNOW]='雪';
  const c = {};
  for (let r = 0; r < ROWS; r++) for (let cc = 0; cc < COLS; cc++){ const v = map[r][cc]; c[v] = (c[v]||0) + 1; }
  return Object.keys(c).map(k => (names[k] || ('#'+k)) + '=' + c[k]).join('  ');
})()`, context);
console.log('\n--- 地形普查（每格每帧重绘的项才算成本）---\n' + census);

/* ---------- 归因：极端压力场景下，绘制成本落在哪些函数上 ---------- */
setup(`
level = 20; startLevel();
for (let i = 0; i < 220; i++){ vnow += 16.7; RAF_CB(vnow); }
for (let k = 0; k < 30; k++) enemies.push(makeTank(SPAWN_POINTS[k % 3].x, SPAWN_POINTS[k % 3].y, 2, k % 5 === 0 ? 'boss' : 'basic', { invuln: 0 }));
for (let k = 0; k < 80; k++) fireBullet(player);
for (let k = 0; k < 40; k++) addExplosion(120 + k * 8, 200 + (k % 5) * 20, 'big');
state = 'playing'; baseAlive = true;
`);
const ATTR_FRAMES = 60;
byFn = Object.create(null);
attributing = true;
for (let i = 0; i < ATTR_FRAMES; i++) { sandbox.vnow += 16.7; sandbox.RAF_CB(sandbox.vnow); }
attributing = false;
console.log('\n--- S3 绘制成本归因（按调用函数，ops/帧）---');
const attr = Object.entries(byFn).sort((a, b) => b[1] - a[1]).slice(0, 14);
for (const [fn, v] of attr) console.log(pad(fn, 22) + (v / ATTR_FRAMES).toFixed(1));
console.log('');
