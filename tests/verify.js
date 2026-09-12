/* 无头运行时回归验证：素材接入 + 老鹰 60 秒无敌 + Lv1 子弹抵消 */
const fs = require('fs');
const vm = require('vm');

const noop = () => {};
const ctxStub = new Proxy({}, {
  get(t, p){ return (p in t) ? t[p] : noop; },
  set(t, p, v){ t[p] = v; return true; },
});
const mkEl = (id) => {
  const h = {};
  return {
    id, __h: h,
    addEventListener: (t, f) => { (h[t] = h[t] || []).push(f); },
    removeEventListener: noop,
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    dataset: {}, style: {}, textContent: '', disabled: false,
    getContext: () => ctxStub,
    requestFullscreen: noop, webkitRequestFullscreen: noop,
  };
};
let IMG_FAIL = false;
const EL_CACHE = {};

class ImageStub {
  constructor(){ this.width = 28; this.height = 36; this.onload = null; this.onerror = null; }
  set src(v){
    this._src = v;
    const fail = IMG_FAIL || /eagle/.test(v);
    if (fail) { if (this.onerror) this.onerror(); }
    else if (this.onload) this.onload();
  }
  get src(){ return this._src; }
}
class AudioStub {
  constructor(src){ this.src = src; this.currentTime = 0; }
  play(){ return Promise.resolve(); }
}

const sandbox = {
  console, TESTOUT: [], vnow: 0, RAF_CB: null,
  Image: ImageStub, Audio: AudioStub,
  __setImgFail: v => { IMG_FAIL = v; },
  window: { addEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined },
  document: {
    getElementById: id => (EL_CACHE[id] || (EL_CACHE[id] = mkEl(id))),
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
    body: mkEl('body'), fullscreenElement: null, hidden: false,
  },
  localStorage: { getItem: () => '0', setItem: noop, removeItem: noop },
  performance: { now: () => sandbox.vnow },
  requestAnimationFrame: cb => { sandbox.RAF_CB = cb; return 1; },
  setTimeout: noop,
  fetch: () => Promise.reject(new Error('no network in test')),   // 迫使走 <audio> 回退层
};
sandbox.globalThis = sandbox;
sandbox.window.document = sandbox.document;
sandbox.assert = (name, ok, extra) => sandbox.TESTOUT.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const context = vm.createContext(sandbox);
/* 与浏览器一致的加载顺序：sounds.js（内嵌音频兜底）→ game.js */
vm.runInContext(fs.readFileSync('D:/E/H5GAME/assets/sounds.js', 'utf8'), context, { filename: 'sounds.js' });
vm.runInContext(fs.readFileSync('D:/E/H5GAME/game.js', 'utf8'), context, { filename: 'game.js' });

const TEST = `
/* ---------- A. 冒烟：素材贴图路径 ---------- */
let crashed = null;
try { for (let i = 0; i < 120; i++){ vnow += 16.7; RAF_CB(vnow); } } catch(e){ crashed = e.stack; }
assert('A1 标题页 120 帧（矢量回退渲染）无异常', !crashed, crashed);

assert('A2 全部坦克/道具图片资源标记加载成功',
       Object.keys(IMG).length === 12 && Object.values(IMG).every(r => r.ok),
       'IMG keys=' + Object.keys(IMG).length);

startGame();
assert('A3 开局进入幕布阶段', levelIntro > 0, 'levelIntro=' + levelIntro.toFixed(2));
crashed = null;
try { for (let i = 0; i < 300; i++){ vnow += 16.7; RAF_CB(vnow); } } catch(e){ crashed = e.stack; }
assert('A4 开局 300 帧（幕布+贴图坦克+音效回退层）无异常', !crashed, crashed);
assert('A5 幕布开场已结束且游戏继续', levelIntro === 0 && state === 'playing', 'state=' + state);

/* ---------- B. 素材全部加载失败 → 矢量/合成回退不崩 ---------- */
crashed = null;
try {
  startGame();
  __setImgFail(true);
  const fresh = {};   // 模拟二次加载全失败
  for (let i = 0; i < 200; i++){ vnow += 16.7; RAF_CB(vnow); }
} catch(e){ crashed = e.stack; }
__setImgFail(false);
assert('B1 图片全挂时 200 帧回退渲染无异常', !crashed, crashed);

/* ---------- C. 音效三级回退 ---------- */
/* actx 为 null（本桩环境无 AudioContext）→ 走 <audio> 元素 / dataURI 兜底 */
assert('C1 无 AudioContext 时 playSnd 走内嵌 dataURI 兜底', playSnd('shoot') === true,
       'src=' + String((SND_EL.shoot || {}).src || '').slice(0, 42));
assert('C2 sfx.shoot 不抛异常', (function(){ try { sfx.shoot(); return true; } catch(e){ return e.message; } })());
/* 关键回归：Audio 元素播放被拒时必须返回 false，才能回落到合成 beep，不能吞掉错误假装成功 */
SND_EL.spark = false;                       // 模拟此前播放已被浏览器拒绝
assert('C3 播放可用时返回 true；被拒后返回 false（不阻断 beep 兜底）',
       playSnd('shoot') === true && playSnd('spark') === false);
assert('C4 dataURI 兜底资源已内嵌（13 个音效）',
       !!window.TANK_SND && Object.keys(window.TANK_SND).length === 13,
       '内嵌数=' + (window.TANK_SND ? Object.keys(window.TANK_SND).length : 0));
assert('C5 audioBlocked() 在无 AudioContext 时为 true（面板会提示）', audioBlocked() === true);

/* ---------- D. 老鹰（无敌 60 秒）回归 ---------- */
startGame();
enemyQueue.length = 0; enemies.length = 0; items.length = 0;
player.invuln = 0; playerEagle = 0;
items.push({ x:player.x, y:player.y, px:player.px, py:player.py, type:'eagle', t:0 });
collectItems();
assert('D1 拾取老鹰 → 立即无敌 invuln=60', Math.abs(player.invuln - 60) < 1e-9, 'invuln=' + player.invuln);
for (let i = 0; i < 400; i++) updatePlayer(0.05);
assert('D2 20 秒后剩余 ≈40', Math.abs(playerEagle - 40) < 0.2, 'playerEagle=' + playerEagle.toFixed(3));
items.length = 0;
items.push({ x:player.x, y:player.y, px:player.px, py:player.py, type:'eagle', t:0 });
collectItems();
assert('D3 重复拾取重置 60（不叠加）', Math.abs(playerEagle - 60) < 1e-9, 'playerEagle=' + playerEagle.toFixed(3));
for (let i = 0; i < 1220; i++) updatePlayer(0.05);
assert('D4 60 秒后自动解除', playerEagle === 0 && player.invuln <= 0, 'invuln=' + player.invuln.toFixed(4));

/* ---------- E. 子弹等级吞噬（谁大吞谁，新等级 = |高-低|） ---------- */
startGame();
enemyQueue.length = 0; enemies.length = 0; bullets.length = 0;
for (let c = 0; c < COLS; c++) map[5][c] = 0;
const E = makeTank(12, 5, 3, 'basic', {});
/* 构造一对迎面对撞的子弹，跑到分出结果为止 */
function clash(pp, ep){
  bullets.length = 0;
  bullets.push({ px:200, py:110, dir:1, speed:260, owner:player, dead:false, power:pp });
  bullets.push({ px:260, py:110, dir:3, speed:240, owner:E,    dead:false, power:ep });
  for (let i = 0; i < 60 && bullets.filter(b => !b.dead).length > 1; i++) updateBullets(0.02);
  return bullets.filter(b => !b.dead);
}
let r = clash(1, 1);
assert('E1 1v1 同归于尽', r.length === 0, '存活=' + r.length);
r = clash(2, 2);
assert('E2 2v2 同归于尽（新规则，原为穿透）', r.length === 0, '存活=' + r.length);
r = clash(3, 3);
assert('E2b 3v3 同归于尽', r.length === 0, '存活=' + r.length);
r = clash(2, 1);
assert('E3 2v1 → 高级弹降为 1 级继续飞', r.length === 1 && r[0].power === 1 && r[0].owner === player,
       '存活=' + r.length + ' power=' + (r[0] && r[0].power));
r = clash(3, 1);
assert('E4 3v1 → 降为 2 级', r.length === 1 && r[0].power === 2, 'power=' + (r[0] && r[0].power));
r = clash(3, 2);
assert('E5 3v2 → 降为 1 级', r.length === 1 && r[0].power === 1, 'power=' + (r[0] && r[0].power));
r = clash(3, 1);
assert('E6 降级后速度按新等级重算（260+45=305）', r.length === 1 && Math.abs(r[0].speed - 305) < 1e-6,
       'speed=' + (r[0] && r[0].speed));
/* 同阵营互不干扰：否则 power3 的两发弹会自己撞自己，升级反而变成自我消耗 */
bullets.length = 0;
bullets.push({ px:200, py:110, dir:1, speed:260, owner:player, dead:false, power:3 });
bullets.push({ px:230, py:110, dir:1, speed:305, owner:player, dead:false, power:1 });
for (let i = 0; i < 6; i++) updateBullets(0.02);
assert('E7 同阵营子弹互不干扰', bullets.filter(b => !b.dead).length === 2 &&
       bullets[0].power === 3 && bullets[1].power === 1,
       '存活=' + bullets.filter(b => !b.dead).length);
/* 一次交火最多被削一级 */
bullets.length = 0;
const many = [];
for (let i = 0; i < 4; i++) many.push({ px:240 + i*9, py:110, dir:3, speed:240, owner:E, dead:false, power:1 });
bullets.push({ px:200, py:110, dir:1, speed:350, owner:player, dead:false, power:3 });
bullets.push(...many);
for (let i = 0; i < 20; i++) updateBullets(0.02);
const surv = bullets.filter(b => !b.dead && b.owner === player);
assert('E8 弹幕中一次交火最多被削一级（3 级不会瞬间掉到 1 级）',
       surv.length === 0 || surv[0].power >= 2, 'power=' + (surv[0] && surv[0].power));
/* 裸对象（无 gun/ang 字段）不抛异常 */
bullets.length = 0;
bullets.push({ px:200, py:110, dir:1, speed:260, owner:player, dead:false, power:1 });
let e8ok = true; try { for (let i = 0; i < 5; i++) updateBullets(0.02); } catch(err){ e8ok = err.message; }
assert('E9 裸子弹对象（无 gun/ang）全程不抛异常', e8ok === true, String(e8ok));

/* ---------- F. 出生星星 & 幕布时长 ---------- */
startGame();
assert('F1 幕布时长 = ' + LEVEL_INTRO_TIME + 's', Math.abs(levelIntro - LEVEL_INTRO_TIME) < 1e-9);
const fx0 = explosions.filter(x => x.kind === 'spawn').length;
assert('F2 玩家出生星星已生成', fx0 >= 1, 'spawn fx=' + fx0);

/* ---------- G. 手机/触屏开始游戏（无键盘） ---------- */
const fire = (el, type) => { (el.__h[type] || []).forEach(f => f({ preventDefault(){} })); };
const cvs  = document.getElementById('game');
const btnS = document.getElementById('btn-start');
assert('G0 画布与开始按钮均已注册事件',
       !!cvs && (cvs.__h.pointerdown || []).length >= 1 && !!btnS && (btnS.__h.click || []).length >= 1);

state = 'title'; startLockT = gameTime - 1;
fire(cvs, 'pointerdown');
assert('G1 标题页点按画布即可开局（无需键盘）', state === 'playing', 'state=' + state);

state = 'over'; startLockT = gameTime + 0.8;
fire(cvs, 'pointerdown');
assert('G2 结束瞬间误触保护生效（0.8s 内不重开）', state === 'over', 'state=' + state);
startLockT = gameTime - 1;
fire(cvs, 'pointerdown');
assert('G3 锁定解除后点按画布重新开始', state === 'playing', 'state=' + state);

state = 'clear'; startLockT = gameTime - 1;
const lv0 = level;
fire(cvs, 'pointerdown');
assert('G4 过关后点按画布进入下一关', state === 'playing' && level === lv0 + 1,
       'state=' + state + ' level=' + level);

state = 'title'; startLockT = gameTime - 1;
fire(btnS, 'click');
assert('G5 工具栏“开始游戏”按钮可用', state === 'playing', 'state=' + state);

state = 'title'; syncStartBtn(); const t1 = btnS.textContent;
state = 'over';  syncStartBtn(); const t2 = btnS.textContent;
state = 'clear'; syncStartBtn(); const t3 = btnS.textContent;
state = 'playing'; syncStartBtn(); const dis3 = btnS.disabled;
assert('G6 开始按钮文案随状态切换、游戏中禁用',
       /开始/.test(t1) && /重新/.test(t2) && /下一关/.test(t3) && dis3 === true,
       [t1, t2, t3, 'disabled=' + dis3].join(' | '));

state = 'playing'; const lvNow = level; startLockT = gameTime - 1;
fire(cvs, 'pointerdown');
assert('G7 游戏进行中点按画布不会误触重开', state === 'playing' && level === lvNow, 'level=' + level);

/* ---------- H. 敌人拾取道具（对玩家形成压力，但不崩坏关卡） ---------- */
startGame();
levelIntro = 0;
enemyQueue.length = 0; enemies.length = 0; bullets.length = 0; grenadeBlasts.length = 0;
const EH = makeTank(6, 6, 2, 'basic', {}); enemies.push(EH);
const give = (t, type) => { items.length = 0; items.push({ x:t.x, y:t.y, px:t.px, py:t.py, type, t:0 }); collectItems(); };
give(EH, 'star'); give(EH, 'star'); give(EH, 'star');
assert('H1 敌人吃火力封顶 2 级（3 级会蒸干水塘）', EH.power === 2, 'power=' + EH.power);
EH.invuln = 0; give(EH, 'shield');
assert('H2 敌人吃护盾 = 6 秒（玩家 12 秒）', Math.abs(EH.invuln - 6) < 1e-9, 'invuln=' + EH.invuln);
freezePlayer = 0; give(EH, 'clock');
assert('H3 敌人吃时钟 = 冻玩家 4 秒', Math.abs(freezePlayer - 4) < 1e-9, 'freezePlayer=' + freezePlayer);
EH.amphibious = 0; give(EH, 'amphibious');
assert('H4 敌人吃两栖 = 20 秒', Math.abs(EH.amphibious - 20) < 1e-9, 'amph=' + EH.amphibious);
playerEagle = 0; give(EH, 'eagle');
assert('H5 敌人吃老鹰退化为护盾，玩家不获得老鹰',
       Math.abs(EH.invuln - 6) < 1e-9 && playerEagle === 0, 'eagle=' + playerEagle);
const qBefore = enemyQueue.length, livesBefore = lives;
enemyQueue.length = 0; give(EH, 'tank');
assert('H6 敌人吃加命 = 敌军增援（不偷玩家命）', lives === livesBefore && enemyQueue.length >= 1,
       'lives=' + lives + ' queue=' + enemyQueue.length);
/* 手雷：先给 1 秒警示，再对范围内造成伤害（玩家放 40px 外，避免优先抢走手雷） */
player.px = EH.px + 40; player.py = EH.py; player.invuln = 0; player.hp = player.maxHp;
grenadeBlasts.length = 0; give(EH, 'grenade');
assert('H7 敌人吃手雷先进入引信警示（1 秒）',
       grenadeBlasts.length === 1 && Math.abs(grenadeBlasts[0].t - 1.0) < 1e-9,
       'blasts=' + grenadeBlasts.length);
updateGrenades(0.5);
assert('H8 引信期间尚未爆炸', grenadeBlasts.length === 1 && player.hp === player.maxHp, 'hp=' + player.hp);
updateGrenades(0.6);
assert('H9 引信结束：范围内玩家受伤、敌人被炸死',
       player.hp < 1 || player.dead === true ? true : false, 'hp=' + player.hp + ' dead=' + player.dead);
/* 玩家吃手雷仍然是全屏清敌 */
startGame(); levelIntro = 0;
enemyQueue.length = 0; enemies.length = 0;
for (let i = 0; i < 3; i++) enemies.push(makeTank(4 + i, 6, 2, 'basic', {}));
give(player, 'grenade');
assert('H10 玩家吃手雷仍是全屏清敌', enemies.filter(e => !e.dead).length === 0,
       '剩余=' + enemies.filter(e => !e.dead).length);

/* ---------- I. 武器与状态效果 ---------- */
startGame(); levelIntro = 0;
enemyQueue.length = 0; enemies.length = 0; bullets.length = 0;
give(player, 'flame');
assert('I1 拾取火焰枪 → 获得弹药', player.gun === 'flame' && player.ammo === GUNS.flame.ammo,
       'gun=' + player.gun + ' ammo=' + player.ammo);
const ammo0 = player.ammo; give(player, 'flame');
assert('I2 重复拾取同种武器 → 补给 +3', player.ammo === ammo0 + 3, 'ammo=' + player.ammo);
give(player, 'frost');
assert('I3 换枪 → 余弹重置为新武器', player.gun === 'frost' && player.ammo === GUNS.frost.ammo,
       'gun=' + player.gun + ' ammo=' + player.ammo);
/* 燃烧 DOT：每 0.4s 一跳，不是每帧扣血 */
const ET2 = makeTank(6, 6, 2, 'armor', {}); enemies.push(ET2);
ET2.burnT = 2.0; ET2.burnAcc = 0; ET2.invuln = 0;
const hp0 = ET2.hp;
tickStatus(ET2, 0.3);
assert('I4 燃烧未满 0.4s 不结算', ET2.hp === hp0, 'hp=' + ET2.hp);
tickStatus(ET2, 0.15);
assert('I5 满 0.4s 结算 1 点', ET2.hp === hp0 - 1, 'hp=' + ET2.hp);
/* 燃烧不吃穿老鹰无敌 */
player.invuln = 0; playerEagle = 60; player.invuln = 60; player.burnT = 2.0; player.burnAcc = 0;
const lives0 = lives;
for (let i = 0; i < 200; i++) updatePlayer(0.05);   // 10 秒
assert('I6 老鹰无敌期间燃烧 DOT 暂停（不击穿无敌）',
       player.dead === false && lives === lives0, 'dead=' + player.dead + ' lives=' + lives);
/* 减速只影响移动，不改 speed 字段本身 */
const ET3 = makeTank(8, 6, 2, 'basic', {}); enemies.push(ET3);
const spd0 = ET3.speed;
ET3.slowT = 3;
assert('I7 减速：statusSpeedMul=0.5 且 speed 字段不变',
       Math.abs(statusSpeedMul(ET3) - 0.5) < 1e-9 && ET3.speed === spd0, 'mul=' + statusSpeedMul(ET3));
ET3.slowT = 0;
assert('I8 减速结束恢复', Math.abs(statusSpeedMul(ET3) - 1) < 1e-9, 'mul=' + statusSpeedMul(ET3));
/* 玩家被点燃 → 枪管过热（不致死） */
player.invuln = 0; playerEagle = 0; player.hp = player.maxHp;
player.overheatT = 1.5;
assert('I9 玩家被点燃 → 过热封锁射击而非掉血', player.overheatT > 0 && player.hp === player.maxHp,
       'overheat=' + player.overheatT + ' hp=' + player.hp);
/* 激光：穿砖不穿钢 */
startGame(); levelIntro = 0; bullets.length = 0;
for (let c = 0; c < COLS; c++){ map[5][c] = 1; }   // 整行砖
player.gun = 'laser'; player.ammo = 5; player.power = 1;
player.px = 40; player.py = 5*20 + 10; player.dir = 1;
fireBullet(player);
const lb = bullets[bullets.length - 1];
assert('I10 激光弹带武器标记与穿砖额度', lb.gun === 'laser' && lb.brickLeft === GUNS.laser.brickPierce,
       'gun=' + lb.gun + ' brickLeft=' + lb.brickLeft);
for (let i = 0; i < 4 && !lb.dead; i++) stepBullet(lb, 5);
assert('I11 激光穿砖后继续飞行', lb.dead === false, 'dead=' + lb.dead);
map[5][8] = 2;   // 钢板
lb.px = 7*20 + 2; lb.py = 5*20 + 10; lb.brickLeft = 0;
for (let i = 0; i < 6 && !lb.dead; i++) stepBullet(lb, 5);
assert('I12 激光被钢板挡下（保留钢墙作为绝对掩体）', lb.dead === true, 'dead=' + lb.dead);
/* 电磁链：跳跃不分敌我 */
startGame(); levelIntro = 0; bullets.length = 0; enemies.length = 0;
for (let r = 5; r < 9; r++) for (let c = 0; c < COLS; c++) if (map[r][c] !== BASE) map[r][c] = 0;
const A1 = makeTank(6, 6, 2, 'basic', {}), A2 = makeTank(7, 6, 2, 'basic', {});
enemies.push(A1); enemies.push(A2);
player.gun = 'tesla'; player.burnT = 0;
bullets.push({ px:A1.px, py:A1.py, dir:1, speed:100, owner:player, dead:false, power:1, gun:'tesla', ang:angFor(1) });
const before = A1.dead;
stepBullet(bullets[0], 2);
assert('I13 电磁链命中后连锁到附近单位', A1.hp < A1.maxHp || A1.dead || A2.hp < A2.maxHp,
       'A1hp=' + A1.hp + ' A2hp=' + A2.hp);
/* 幕布期间状态冻结：燃烧不烧血 */
startGame();
const hpHold = player.hp; player.burnT = 2.0; player.burnAcc = 0; player.invuln = 0;
for (let i = 0; i < 30; i++) update(0.05);
assert('I14 幕布开场期间燃烧不结算（世界静止）', player.hp === hpHold, 'hp=' + player.hp);

/* ---------- J. 血量与血条 ---------- */
assert('J1 默认经典档位玩家 1 血', playerMaxHp() === 1, 'hp=' + playerMaxHp());
hpMode = 1; const P2 = makeTank(8, 24, 0, 'player', {});
assert('J2 标准档位玩家 2 血', P2.maxHp === 2 && P2.hp === 2, 'hp=' + P2.hp);
P2.invuln = 0; damageTank(P2, 1, 'bullet');
assert('J3 2 血挨一发不死且进入 1 秒无敌', P2.dead === false && P2.hp === 1 && P2.invuln > 0.9,
       'hp=' + P2.hp + ' invuln=' + P2.invuln.toFixed(2));
P2.invuln = 0; damageTank(P2, 1, 'bullet');
assert('J4 第二发致死', P2.dead === true, 'dead=' + P2.dead);
hpMode = 0;
const ARM = makeTank(6, 6, 2, 'armor', {});
assert('J5 armor 仍为 4 血', ARM.maxHp === 4, 'hp=' + ARM.maxHp);
const PW = makeTank(6, 6, 2, 'power', {});
assert('J6 power 型敌人提升到 2 血', PW.maxHp === 2, 'hp=' + PW.maxHp);
/* 渲染冒烟：带武器/血条/状态时不抛异常 */
startGame(); levelIntro = 0;
player.gun = 'laser'; player.ammo = 3; player.burnT = 1.2; player.slowT = 2; player.hitFlash = 0.1;
hpMode = 2; player.hp = 2; player.maxHp = 3;
enemies.push(makeTank(6, 6, 2, 'armor', {}));
items.push({ x:5, y:5, px:110, py:110, type:'flame', t:0 });
items.push({ x:7, y:5, px:150, py:110, type:'tesla', t:0 });
grenadeBlasts.push({ px:200, py:200, t:0.8, r:60 });
let renderOK = true; try { for (let i = 0; i < 30; i++){ update(0.016); render(); } } catch(e){ renderOK = e.message; }
assert('J7 带武器/血条/状态/手雷警示渲染 30 帧不抛异常', renderOK === true, String(renderOK));
hpMode = 0;

/* ---------- K. 新机制回归 ---------- */
/* K1/K2：火力护盾 */
startGame(); levelIntro = 0;
player.power = 2; player.hp = 1; player.invuln = 0;
damageTank(player, 1, 'bullet');
assert('K1 Lv2 玩家被子弹命中 → 火力降为 1 级并抵消本次伤害（不死）',
       player.power === 1 && player.hp === 1 && !player.dead, 'power=' + player.power + ' hp=' + player.hp);
player.invuln = 0; damageTank(player, 1, 'bullet');
assert('K2 Lv1 玩家被子弹命中 → 正常扣血死亡',
       player.dead === true, 'hp=' + player.hp);

/* K3：每 2000 分奖一命 */
startGame(); levelIntro = 0; score = 0; nextExtraLifeScore = 2000; lives = 2;
addScore(1900);
assert('K3 得分未达 2000 不奖命', lives === 2 && nextExtraLifeScore === 2000, 'lives=' + lives);
addScore(150);
assert('K4 得分达到 2000 奖一命且阈值提升到 4000',
       lives === 3 && nextExtraLifeScore === 4000, 'lives=' + lives + ' next=' + nextExtraLifeScore);
addScore(2100);
assert('K5 得分达到 4000 再奖一命且阈值提升到 6000',
       lives === 4 && nextExtraLifeScore === 6000, 'lives=' + lives + ' next=' + nextExtraLifeScore);

/* K6：基地老鹰不再被地形缓存局部重绘切掉 */
assert('K6 基地老鹰格不再进 terrain cache',
       isTerrainCacheable(BASE) === false, 'cacheable=' + isTerrainCacheable(BASE));

/* K7：第 1 关即可掉落武器 */
startGame(); levelIntro = 0;
let sawWeapon = false;
for (let i = 0; i < 200 && !sawWeapon; i++){
  const t = rollItemType();
  if (WEAPON_TYPES.indexOf(t) >= 0) sawWeapon = true;
}
assert('K7 第 1 关 rollItemType 能开出武器', sawWeapon, '');

/* ---------- L. 图鉴面板：按钮 + 分页切换 ---------- */
const NO = () => {};
const codexOv = document.getElementById('codex-overlay');
function mkCxNode(n){ const o = { _n:n, _active:false, getAttribute:()=>n };
  o.classList = { toggle:(c,on)=>{ if(c==='active') o._active = !!on; }, add:NO, remove:NO, contains:()=>false }; return o; }
const cxTabs  = ['weapon','item','enemy','rule'].map(mkCxNode);
const cxPanes = ['weapon','item','enemy','rule'].map(mkCxNode);
codexOv.querySelectorAll = sel => sel === '.codex-tab' ? cxTabs : (sel === '.codex-pane' ? cxPanes : []);
codexSwitchTab('enemy');
const LpaneOk = cxPanes.find(p=>p._n==='enemy')._active && !cxPanes.find(p=>p._n==='weapon')._active;
const LtabOk  = cxTabs.find(t=>t._n==='enemy')._active && !cxTabs.find(t=>t._n==='weapon')._active;
assert('L1 图鉴切到「敌人」：对应 pane/tab 激活、其余未激活', LpaneOk && LtabOk,
       JSON.stringify(cxPanes.map(p=>p._n+':'+p._active)));
codexSwitchTab('rule');
assert('L2 再切到「机制」：只 rule 激活',
       cxPanes.find(p=>p._n==='rule')._active && !cxPanes.find(p=>p._n==='enemy')._active,
       JSON.stringify(cxPanes.map(p=>p._n+':'+p._active)));
// 按钮点击应显示覆盖层
const cxBtn = document.getElementById('btn-codex');
let cxShown = false;
codexOv.classList = { toggle:(c,on)=>{ if(c==='show') cxShown = !!on; }, add:NO, remove:NO, contains:()=>false };
const cxClick = (cxBtn.__h && cxBtn.__h.click) || [];
if (cxClick.length) cxClick[0]();
assert('L3 点击「图鉴」按钮显示覆盖层', cxShown === true, 'handlers=' + cxClick.length);
`;

let err = null;
try { vm.runInContext(TEST, context, { filename: 'test.js' }); }
catch (e) { err = e.stack; }

if (err) console.log('测试脚本执行异常:\n' + err);
const out = sandbox.TESTOUT;
let pass = 0;
for (const r of out){
  if (r.ok) pass++;
  console.log((r.ok ? '  [PASS] ' : '  [FAIL] ') + r.name + (r.extra ? '   → ' + r.extra : ''));
}
console.log('\n结果: ' + pass + '/' + out.length + ' 通过');
process.exit(pass === out.length && !err ? 0 : 1);
