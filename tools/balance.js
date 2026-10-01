/* 平衡试玩模拟器（受控压力测试）：脚本 AI 代打前 N 关，量化难度曲线。
 *
 * 口径说明（务必先读，别把它当人类水平）
 * - 这个 AI 只会「追最近的敌人 + 轴线对齐时开火」，不会预判、不会卡位、不刻意捡道具，
 *   火力等级低时还受「同屏弹数 = 火力等级」限制，远距离对射效率很差。
 *   因此它的死亡次数远高于真人，绝对值没有意义。
 * - 所以这里把基地设为【不可毁】，只测「纯战斗压力」：多久清一关、死几次、
 *   捡到几把武器、攒到几条奖命。各档之间的**相对变化**才是要看的难度曲线。
 * - 真人试玩不能由它替代；它只负责给出一把稳定的尺子。
 * - 固定随机种子 → 同一提交上结果可复现，改动前后可直接对比。
 *
 * 运行： node tools/balance.js [关卡数]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const LEVELS = parseInt(process.argv[2], 10) || 12;
const SEED = 20261001;
const noop = () => {};

/* ---- 确定性随机（mulberry32）：同一 seed 下每次跑出完全一样的结果 ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const MathStub = Object.create(Math);
MathStub.random = rand;

const ctxStub = new Proxy({}, {
  get(t, p) { if (p in t) return t[p]; return noop; },
  set(t, p, v) { t[p] = v; return true; },
});
const mkEl = (id) => ({
  id, __h: {},
  addEventListener: noop, removeEventListener: noop,
  classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
  dataset: {}, style: {}, textContent: '', disabled: false, value: '0',
  getContext: () => ctxStub, requestFullscreen: noop, webkitRequestFullscreen: noop,
});
const EL_CACHE = {};
class ImageStub { constructor() { this.width = 28; this.height = 36; } set src(v) { this._src = v; if (this.onload) this.onload(); } get src() { return this._src; } }
class AudioStub { constructor(src) { this.src = src; this.currentTime = 0; } play() { return Promise.resolve(); } }

const sandbox = {
  console, vnow: 0, RAF_CB: null,
  Math: MathStub,
  Image: ImageStub, Audio: AudioStub,
  window: { addEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, devicePixelRatio: 1 },
  document: {
    getElementById: id => (EL_CACHE[id] || (EL_CACHE[id] = mkEl(id))),
    querySelectorAll: () => [], addEventListener: noop,
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

/* 脚本 AI：基准线玩家。守家优先 + 追击最近敌人，轴线对齐时开火。
 * 目标评分 = 到玩家距离 + 2.5 × 到基地距离 —— 逼过来的敌人优先处理，
 * 否则会出现"一路追杀、老家被偷"，那样量到的是 AI 的缺陷而非关卡难度。
 * 仍不做走位规避、不刻意捡道具，保持"最笨的合格玩家"这一基准。 */
vm.runInContext(`
const __ALIGN = 26;                              // 轴线对齐容差（坦克宽 21）
const __RANGE = 150;                             // 开火距离：power 1 时同屏只允许 1 发，
                                                 // 远距离对射等于把唯一弹位浪费在飞行途中
let __stuckX = 0, __stuckY = 0, __stuckT = 0, __altAxis = 0;
function __dist(ax, ay, bx, by){ const dx = ax - bx, dy = ay - by; return Math.sqrt(dx*dx + dy*dy); }
function __botStep(){
  const k = keys;
  k.KeyW = k.KeyS = k.KeyA = k.KeyD = false; k.Space = false;
  if (!player || player.dead) return;
  let tgt = null, best = Infinity;
  for (const e of enemies){
    if (e.dead) continue;
    const d = __dist(e.px, e.py, player.px, player.py);
    if (d < best){ best = d; tgt = e; }
  }
  if (!tgt) return;
  const dx = tgt.px - player.px, dy = tgt.py - player.py;
  const wantX = __altAxis > 0 ? (Math.abs(dx) <= Math.abs(dy)) : (Math.abs(dx) > Math.abs(dy));
  if (__altAxis > 0) __altAxis--;
  const inRange = best < __RANGE;
  if (wantX){
    if (dx > 3) k.KeyD = true; else if (dx < -3) k.KeyA = true;
    if (inRange && Math.abs(dy) < __ALIGN) k.Space = true;
  } else {
    if (dy > 3) k.KeyS = true; else if (dy < -3) k.KeyW = true;
    if (inRange && Math.abs(dx) < __ALIGN) k.Space = true;
  }
  /* 反卡死：想动却 0.5 秒没挪窝（撞墙/卡角）→ 换另一个轴走一会儿 */
  __stuckT++;
  if (__stuckT >= 30){
    const moved = __dist(player.px, player.py, __stuckX, __stuckY);
    if (moved < 3 && __altAxis === 0) __altAxis = 30;
    __stuckX = player.px; __stuckY = player.py; __stuckT = 0;
  }
}
/* 受控压力测试：把基地设为不可毁。
 * 理由：这个机器人只会"追着最近的敌人打"，不会预判、不会卡位，真人几秒就能
 * 守住的进攻它也会漏 —— 基地一炸整局就断了，后面几档一点数据都拿不到。
 * 关掉基地毁灭后，比赛变成"纯战斗压力"：它能撑多久、死几次、多久清一关，
 * 这些量在各档之间的相对变化才是我们要的难度曲线。 */
destroyBase = function(){ /* 模拟专用：基地不可毁 */ };
/* 帧级采样：返回当前状态快照，供 Node 侧统计 */
function __snap(){
  return {
    state, level, lives, score, dead: !!(player && player.dead),
    gun: (player && player.gun) || 'normal',
    intro: levelIntro, enemies: enemies.length, queue: enemyQueue.length,
    hp: player ? player.hp : 0, maxHp: player ? player.maxHp : 0,
    /* 受击信号：damageTank 会把 hitFlash 置 0.12，取上升沿计数。
     * 死亡是稀疏事件（一关可能 0~2 次），受击次数密度高得多，
     * 用它在各档之间做对比更稳。 */
    hitFlash: player ? player.hitFlash : 0,
    base: baseAlive,
  };
}
`, context, { filename: 'bot.js' });

const step = () => { sandbox.vnow += 1000 / 60; sandbox.RAF_CB(sandbox.vnow); };
const snap = () => vm.runInContext('__snap()', context);
vm.runInContext('startGame()', context);

const MAX_SEC = 150;                 // 单关上限：超时视为"卡住"
const results = [];
let prev = snap();

for (let i = 0; i < LEVELS; i++) {
  const lv = snap().level;    // 以游戏内的真实关卡为准，避免与推进逻辑漂移
  // 等待本关开始（幕布结束）
  let guard = 0;
  while (snap().intro > 0 && guard++ < 60 * 30) step();
  /* 受控条件：每关补满命数（上限 6），并在中途命尽时自动续命。
   * 否则机器人一路死到 0 命，游戏在第 6 关就结束，精锐/王牌/噩梦三档拿不到数据。
   * 我们量的是"压力"（受击/分），不是"能不能活下来"，所以补命不影响结论。 */
  vm.runInContext('lives = 6; lives2 = 6;', context);

  let frames = 0, deaths = 0, hits = 0, weapons = 0, lives0 = snap().lives, score0 = snap().score;
  let lastDead = false, lastGun = 'normal', bonusLives = 0, lastFlash = 0;
  let lastProgress = 0, lastScore = score0, lastEnemyN = snap().enemies;
  let stuck = false;
  const cap = 60 * MAX_SEC;
  const STALL = 60 * 15;      // 15 秒既没加分也没减少敌人 → 判定"机器人追不到最后几只"

  while (frames < cap) {
    vm.runInContext('__botStep()', context);
    step();
    frames++;
    const s = snap();
    if (s.dead && !lastDead) deaths++;
    lastDead = s.dead;
    if (s.hitFlash > 0 && lastFlash <= 0) hits++;   // 受击上升沿
    lastFlash = s.hitFlash;
    if (s.gun !== 'normal' && lastGun === 'normal') weapons++;
    lastGun = s.gun;
    if (s.lives > lives0 + bonusLives) bonusLives = s.lives - lives0;
    if (s.score !== lastScore || s.enemies !== lastEnemyN){
      lastScore = s.score; lastEnemyN = s.enemies; lastProgress = frames;
    }
    if (s.state === 'clear') break;
    if (s.state === 'over'){                       // 命尽 → 续命继续测（受控条件）
      vm.runInContext('lives = 6; lives2 = 6; baseAlive = true; state = "playing";', context);
      lastDead = false; lastFlash = 0;
    }
    if (frames - lastProgress > STALL){ stuck = true; break; }
  }

  const s = snap();
  results.push({
    lv, sec: frames / 60, deaths, hits, weapons, bonusLives, stuck,
    score: s.score - score0, out: s.state, lives: s.lives,
  });

  if (s.state === 'over') break;              // 命尽：整局结束，后续关卡无数据
  if (s.state === 'clear') vm.runInContext('nextLevel()', context);
  else vm.runInContext('level++; startLevel()', context);   // 卡住/超时：强制进下一关
  prev = s;
}

/* ---------- 输出 ---------- */
const pad = (s, n) => String(s).padEnd(n, ' ');
const tierName = (lv) => ['新兵', '老兵', '精锐', '王牌', '噩梦'][Math.floor((lv - 1) / 5)] || '?';
const kindOf = (lv) => (lv % 5 === 0 ? 'BOSS' : lv % 5 === 4 ? '精英' : '普通');

console.log('\n=== 坦克 1998 · 受控压力测试（基地不可毁）===');
console.log('种子 ' + SEED + ' · AI=「追敌+轴线对齐开火」，比真人笨得多；只看各档相对趋势\n');
const perMin = (r, n) => r.sec > 0 ? (n / r.sec * 60) : 0;
console.log(pad('关', 5) + pad('档位', 7) + pad('类型', 7) + pad('耗时s', 8) + pad('死亡', 6) +
            pad('受击', 6) + pad('受击/分', 9) + pad('得分', 8) + pad('武器', 6) + pad('奖命', 6) + '结果');
for (const r of results) {
  console.log(
    pad(r.lv, 5) + pad(tierName(r.lv), 7) + pad(kindOf(r.lv), 7) +
    pad(r.sec.toFixed(1), 8) + pad(r.deaths, 6) + pad(r.hits, 6) +
    pad(perMin(r, r.hits).toFixed(1), 9) + pad(r.score, 8) +
    pad(r.weapons, 6) + pad(r.bonusLives, 6) +
    (r.out === 'clear' ? '过关' : r.out === 'over' ? '命尽（整局结束）' : r.stuck ? '卡住（机器人追不到残留敌）' : '超时')
  );
}

/* 按档位汇总：看难度是否在某档突然陡增 */
console.log('\n--- 按档位汇总（主指标 = 死亡/关，越小越轻松）---');
console.log(pad('档位', 8) + pad('关卡', 6) + pad('死亡/关', 9) + pad('相对新兵', 10) +
            pad('受击/分', 10) + pad('得分/关', 9) + '档内递增');
const tiers = {};
for (const r of results) { const t = tierName(r.lv); (tiers[t] = tiers[t] || []).push(r); }
const avg = (g, f) => g.reduce((a, r) => a + f(r), 0) / g.length;
let prevDie = null;
for (const t of ['新兵', '老兵', '精锐', '王牌', '噩梦']) {
  const g = tiers[t]; if (!g) continue;
  const die = avg(g, r => r.deaths);
  const rel = tiers['新兵'] ? die / avg(tiers['新兵'], r => r.deaths) : 1;
  const step = prevDie === null ? '—' : (die >= prevDie * 0.9 ? '↑' : '⚠ 几乎持平/回退');
  console.log(pad(t, 8) + pad(g.length, 6) + pad(die.toFixed(2), 9) + pad(rel.toFixed(2) + 'x', 10) +
              pad(avg(g, r => perMin(r, r.hits)).toFixed(1), 10) +
              pad(Math.round(avg(g, r => r.score)), 9) + step);
  prevDie = die;
}
console.log('\n注意：机器人打不完残局（总在"卡住"结束）——它不会卡位、不会预判，');
console.log('      所以"耗时"与"过关"不可信；能看的是【受击/分】随档位的相对变化。');
console.log('      真人试玩请用 PLAYTEST 清单，不要拿这张表当结论。\n');
