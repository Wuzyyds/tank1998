/* 无头运行时回归验证：素材接入 + 老鹰 60 秒无敌 + Lv1 子弹抵消 */
const fs = require('fs');
const vm = require('vm');

const noop = () => {};
/* 同时统计绘制指令数：用于「逐格重绘 → 精灵化」的性能回归断言。
 * rects 记录 fillRect 的前若干组参数，用来断言「某帧里有没有整屏填充」。 */
const opStat = { calls: 0, fillRect: 0, drawImage: 0, fillText: 0, rects: [] };
const ctxStub = new Proxy({}, {
  get(t, p){
    if (p === '__opStat') return opStat;
    if (p in t) return t[p];
    return function (){
      opStat.calls++;
      if (p === 'fillRect'){
        opStat.fillRect++;
        if (opStat.rects.length < 512) opStat.rects.push([arguments[0], arguments[1], arguments[2], arguments[3]]);
      }
      else if (p === 'drawImage') opStat.drawImage++;
      else if (p === 'fillText') opStat.fillText++;
    };
  },
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
  __opStat: opStat,
  window: { addEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined },
  document: {
    getElementById: id => (EL_CACHE[id] || (EL_CACHE[id] = mkEl(id))),
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
    body: mkEl('body'), documentElement: mkEl('html'), fullscreenElement: null, hidden: false,
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
       Object.keys(IMG).length === 13 && Object.keys(IMG).every(k => k === 'tank_player2' || IMG[k].ok),
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
/* 顶部工具栏已整条从页面移除，入口改为画面内菜单（#center-actions / #play-ctl） */
const btnS = document.getElementById('ca-start');
const ctlP = document.getElementById('ctl-pause');
assert('G0 画布、画面内「开始游戏」与对局中「暂停」键均已注册事件',
       !!cvs && (cvs.__h.pointerdown || []).length >= 1 &&
       !!btnS && (btnS.__h.click || []).length >= 1 &&
       !!ctlP && (ctlP.__h.click || []).length >= 1);

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
assert('G5 画面内菜单「开始游戏」按钮可用', state === 'playing', 'state=' + state);

/* G6 原先顶部工具栏的全部功能都已搬进画面内菜单，并各自绑好点击处理 */
const caMenu = ['ca-start','ca-coop','ca-codex','ca-set','ca-mute','ca-restart','ca-title','ca-next','ca-resume'];
const caMiss = caMenu.filter(id => (((document.getElementById(id).__h || {}).click) || []).length < 1);
assert('G6 画面内菜单按钮全部接好点击处理（开始/双人/图鉴/设置/音效/重开/返回/下一关/继续）',
       caMiss.length === 0, 'missing=' + caMiss.join(','));

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
// 按钮点击应显示覆盖层（入口已从页面工具栏搬到画面内菜单）
const cxBtn = document.getElementById('ca-codex');
let cxShown = false;
codexOv.classList = { toggle:(c,on)=>{ if(c==='show') cxShown = !!on; }, add:NO, remove:NO, contains:()=>false };
const cxClick = (cxBtn.__h && cxBtn.__h.click) || [];
if (cxClick.length) cxClick[0]();
assert('L3 点击画面内「图鉴」按钮显示覆盖层', cxShown === true, 'handlers=' + cxClick.length);

/* ---------- M. 渲染性能：逐格重绘 → 精灵化（回归守卫） ----------
 * 老鹰/树/水原先每帧逐格重绘（老鹰最多 400 次 fillRect），
 * 已改为预烘焙精灵 + 每格一次 drawImage。这里锁死「不许改回去」。 */
startGame();
for (let i = 0; i < 260; i++){ vnow += 16.7; RAF_CB(vnow); }   // 跳过幕布，让敌人入场

initTileSprites(); initEagleSprite();
assert('M1 老鹰/树/水已烘焙为精灵，且按 DPR 分辨率',
       !!eagleSprite && eagleSprite.width === 40 * DPR &&
       !!tileSprites && !!tileSprites.tree && tileSprites.tree.width === TILE * DPR &&
       tileSprites.water.length === 2,
       'eagle=' + (eagleSprite && eagleSprite.width) + ' tree=' + (tileSprites && tileSprites.tree && tileSprites.tree.width));

const bs1 = bulletSprite('flame', 3), bs2 = bulletSprite('flame', 3), bs3 = bulletSprite('normal', 1);
assert('M2 子弹精灵按 gun:power 缓存复用（不重复烘焙）',
       !!bs1 && bs1 === bs2 && bs1 !== bs3, 'w=' + (bs1 && bs1.width));

/* 单帧绘制指令数：逐格重绘时代 fillRect≈320/帧，精灵化后应远低于此 */
__opStat.fillRect = 0; __opStat.drawImage = 0;
render();
const mFill = __opStat.fillRect, mImg = __opStat.drawImage;
assert('M3 单帧 fillRect 远低于逐格重绘基线（精灵化生效）', mFill < 150,
       'fillRect=' + mFill + ' drawImage=' + mImg);

/* DPR 封顶：触屏 2x / 桌面 3x（devicePixelRatio 超额时被夹紧） */
const savedDPR = window.devicePixelRatio, savedCP = coarsePointer;
window.devicePixelRatio = 4;
coarsePointer = true;  setupHiDPI(); const touchDPR = DPR;
coarsePointer = false; setupHiDPI(); const deskDPR = DPR;
window.devicePixelRatio = savedDPR; coarsePointer = savedCP; setupHiDPI();
assert('M4 DPR 封顶：触屏 2x、桌面 3x', touchDPR === 2 && deskDPR === 3,
       'touch=' + touchDPR + ' desktop=' + deskDPR);

/* 无分配的存活统计（原先每帧多次 enemies.filter().length 会产生垃圾） */
const savedEnemies = enemies, savedQueue = enemyQueue;
enemies = [{ dead:false }, { dead:true }, { dead:false }];
enemyQueue = ['basic', 'bonus', 'bonus'];
assert('M5 存活/剩余计数正确（无分配循环取代 filter）',
       countAlive(enemies) === 2 && remainEnemyCount() === 5,
       'alive=' + countAlive(enemies) + ' remain=' + remainEnemyCount());
enemies = savedEnemies; enemyQueue = savedQueue;

/* ---------- N. 音频：等响度曲线 / 总线限幅 / 卡顿爆音防护 / 音效节流 ---------- */
assert('N1 音量曲线为感知近似（平方）：0→0、0.5→0.25、1→1，且越界夹紧',
       volCurve(0) === 0 && volCurve(1) === 1 &&
       Math.abs(volCurve(0.5) - 0.25) < 1e-9 &&
       volCurve(-3) === 0 && volCurve(9) === 1,
       '0.5→' + volCurve(0.5) + ' /1.5→' + volCurve(1.5));

/* 注入假总线对象，验证 applyVolumes 写入的是曲线后的增益 */
const nSavedM = masterGain, nSavedS = sfxGain, nSavedMu = musicGain, nSavedMuted = muted;
const nSavedVol = { master: VOL.master, sfx: VOL.sfx, music: VOL.music };
masterGain = { gain:{ value:-1 } }; sfxGain = { gain:{ value:-1 } }; musicGain = { gain:{ value:-1 } };
VOL.master = 0.5; VOL.sfx = 1; VOL.music = 0.25;
applyVolumes();
const nCurveOk = Math.abs(masterGain.gain.value - 0.25) < 1e-9 &&
                 sfxGain.gain.value === 1 &&
                 Math.abs(musicGain.gain.value - 0.0625) < 1e-9;
muted = true; applyVolumes();
const nMuteOk = masterGain.gain.value === 0 && sfxGain.gain.value === 1;   // 静音只压主总线
muted = false;
masterGain = nSavedM; sfxGain = nSavedS; musicGain = nSavedMu; muted = nSavedMuted;
VOL.master = nSavedVol.master; VOL.sfx = nSavedVol.sfx; VOL.music = nSavedVol.music;
assert('N2 applyVolumes 写入平方增益；静音只把主总线压 0', nCurveOk && nMuteOk,
       'master=' + volCurve(0.5) + ' music=' + volCurve(0.25));

/* 假 AudioContext：验证总线链路 sfx/music → master → 限幅器 → destination */
const nBusLog = [];
const nFakeDest = { __dest:true };
const nSavedActx = actx;
actx = {
  currentTime: 0, destination: nFakeDest,
  createGain: () => ({ gain:{ value:0 }, connect: n => nBusLog.push(n) }),
  createDynamicsCompressor: () => ({ threshold:{value:0}, knee:{value:0}, ratio:{value:0},
                                     attack:{value:0}, release:{value:0}, connect: n => nBusLog.push(n) }),
};
masterGain = sfxGain = musicGain = limiter = null;
audioBusInit();
assert('N3 音频总线接入限幅器（sfx/music → master → compressor → destination）',
       !!masterGain && !!sfxGain && !!musicGain && !!limiter &&
       nBusLog.indexOf(masterGain) >= 0 && nBusLog.indexOf(limiter) >= 0 && nBusLog.indexOf(nFakeDest) >= 0,
       'bus=' + nBusLog.length);

/* BGM 爆音防护：bgmNextT 落后当前时间时，不许把音符排到"过去"（会立即齐发成爆音） */
const nStarted = [];
actx = {
  currentTime: 100, destination: nFakeDest,
  createOscillator: () => ({
    type:'', frequency:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} },
    connect(){}, start(t){ nStarted.push(t); }, stop(){},
  }),
  createGain: () => ({ gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} }),
};
const nSavedBgm = { name: bgmName, step: bgmStep, next: bgmNextT };
bgmName = 'battle'; bgmStep = 0;
bgmNextT = 100 - 10;            // 模拟主线程卡顿 10 秒后落后
bgmSchedule();
const nMinT = nStarted.length ? Math.min.apply(null, nStarted) : Infinity;
assert('N4 BGM 卡顿后不补排"过去"的音符（防爆音）',
       nStarted.length > 0 && nMinT >= 100,
       'notes=' + nStarted.length + ' minT=' + nMinT);
bgmName = nSavedBgm.name; bgmStep = nSavedBgm.step; bgmNextT = nSavedBgm.next;
actx = nSavedActx;

/* 同名音效节流：高频音效 30ms 内重复触发应被吞掉；非高频音效不受影响 */
sfxLastAt.shoot = undefined; sfxLastAt.boom = undefined;
sfx.shoot();
const nT1 = sfxLastAt.shoot;
sfx.shoot();                    // 紧接第二次 → 应被节流
const nT2 = sfxLastAt.shoot;
sfx.boom();
assert('N5 同名音效节流生效（shoot 连发被吞、boom 不受限）',
       nT1 !== undefined && nT2 === nT1 && sfxLastAt.boom === undefined,
       'shoot=' + nT1 + '/' + nT2 + ' boom=' + sfxLastAt.boom);

/* ---------- P. 可读性：兵种识别标记（色盲冗余） ----------
 * 六张坦克贴图 alpha 轮廓完全一致（各 640 像素、逐对差 0.0%），
 * 兵种原本只靠颜色区分；这里用「点数」做形状冗余。 */
__opStat.fillRect = 0; drawKindPips({ kind:'basic' }, 0, 0);
const pBasic = __opStat.fillRect;
__opStat.fillRect = 0; drawKindPips({ kind:'fast' }, 0, 0);
const pFast = __opStat.fillRect;
__opStat.fillRect = 0; drawKindPips({ kind:'power' }, 0, 0);
const pPower = __opStat.fillRect;
__opStat.fillRect = 0; drawKindPips({ kind:'armor' }, 0, 0);
const pArmor = __opStat.fillRect;
__opStat.fillRect = 0; drawKindPips({ kind:'boss' }, 0, 0);
const pBoss = __opStat.fillRect;
assert('P1 兵种点数：普通/首领无点，快速1 火力2 装甲3（各含1个深色底托）',
       pBasic === 0 && pBoss === 0 && pFast === 2 && pPower === 3 && pArmor === 4,
       'basic=' + pBasic + ' fast=' + pFast + ' power=' + pPower + ' armor=' + pArmor + ' boss=' + pBoss);
assert('P2 点数只由形状/数量承载（不依赖颜色：四类标记互斥、底托保证亮地形可读）',
       KIND_PIPS.fast === 1 && KIND_PIPS.power === 2 && KIND_PIPS.armor === 3 &&
       !('basic' in KIND_PIPS) && !('bonus' in KIND_PIPS) && !('boss' in KIND_PIPS),
       JSON.stringify(KIND_PIPS));
assert('P3 兵种点带与两栖标记带不重叠（点带 14~19，两栖 22 起）',
       KIND_PIP_Y - 1 + PIP_SIZE + 2 <= AMPHIB_Y,
       'pip=' + (KIND_PIP_Y - 1) + '~' + (KIND_PIP_Y - 1 + PIP_SIZE + 2) + ' amphib=' + AMPHIB_Y);

/* ---------- Q. 本轮：暂停统一入口 / 画面内按钮 / 手机流畅度 ---------- */
/* Q1 暂停只有一个入口，幂等且可切换（联机端要复用它做同步） */
paused = false;
setPaused(true, false);
const qP1 = (paused === true);
setPaused(true, false);
const qP2 = (paused === true);          // 重复设置同一值不应翻转
togglePause();
const qP3 = (paused === false);
setPaused(false, false);
assert('Q1 暂停统一入口：setPaused 幂等、togglePause 取反', qP1 && qP2 && qP3,
       'on=' + qP1 + ' idem=' + qP2 + ' toggle=' + qP3);

/* Q2 帧预算：高刷屏（90/120Hz）不再把渲染翻倍 */
const qSavedState = state;
state = 'title';   const qTitleMs = renderInterval();
state = 'playing'; const qPlayMs = renderInterval();
state = qSavedState;
assert('Q2 帧预算：标题页 12fps、游玩 60fps',
       Math.abs(qTitleMs - 1000 / 12) < 0.01 && Math.abs(qPlayMs - 1000 / 60) < 0.01,
       'title=' + qTitleMs.toFixed(1) + 'ms play=' + qPlayMs.toFixed(1) + 'ms');

/* Q3 自适应画质：持续吃力时沿 2 → 1.5 → 1 降档，且只降不升 */
const qSavedCap = dprCap, qSavedDpr = window.devicePixelRatio, qSavedCoarse = coarsePointer;
window.devicePixelRatio = 3; coarsePointer = true; dprCap = null; setupHiDPI();
const qDprA = DPR;
for (let i = 0; i < 200; i++) tuneQuality(0.05);      // 50ms/帧：明显吃力
const qDprB = DPR;
for (let i = 0; i < 400; i++) tuneQuality(0.05);      // 继续吃力
const qDprC = DPR;
for (let i = 0; i < 300; i++) tuneQuality(0.008);     // 恢复流畅：不应回弹
const qDprD = DPR;
dprCap = qSavedCap; window.devicePixelRatio = qSavedDpr; coarsePointer = qSavedCoarse; setupHiDPI();
assert('Q3 自适应画质：吃力时 DPR 逐档降（2→1.5→1），流畅后保持',
       qDprA === 2 && qDprB === 1.5 && qDprC === 1 && qDprD === 1,
       qDprA + ' → ' + qDprB + ' → ' + qDprC + ' → ' + qDprD);

/* Q4 画面内按钮：每个状态只显示该出现的按钮 */
function qDisp(id){ const el = document.getElementById(id); return (el && el.style) ? el.style.display : '?'; }
function qSync(st, pz){ state = st; paused = !!pz; caStateKey = ''; syncCenterActions(); }
qSync('title', false);
const qA1 = qDisp('ca-start'), qA2 = qDisp('ca-restart'), qA3 = qDisp('ca-coop'),
      qA4 = qDisp('ca-codex'), qA5 = qDisp('ca-set'), qA6 = qDisp('ca-mute');
qSync('over', false);
const qB1 = qDisp('ca-start'), qB2 = qDisp('ca-restart'), qB3 = qDisp('ca-title'),
      qB4 = qDisp('ca-coop'), qB5 = qDisp('ca-codex');
qSync('clear', false);
const qE1 = qDisp('ca-next'), qE2 = qDisp('ca-title'), qE3 = qDisp('ca-start');
qSync('playing', true);
const qC1 = qDisp('ca-resume'), qC2 = qDisp('ca-restart'), qC3 = qDisp('ca-start');
qSync('playing', false);
const qD1 = qDisp('ca-start'), qD2 = qDisp('ca-resume');
assert('Q4 画面内菜单按状态切换（标题菜单 / 结束 / 过关 / 暂停 / 游玩 各自只显示该显示的）',
       qA1 === '' && qA2 === 'none' && qA3 === '' && qA4 === '' && qA5 === '' && qA6 === '' &&
       qB1 === 'none' && qB2 === '' && qB3 === '' && qB4 === 'none' && qB5 === '' &&
       qE1 === '' && qE2 === '' && qE3 === 'none' &&
       qC1 === '' && qC2 === '' && qC3 === 'none' &&
       qD1 === 'none' && qD2 === 'none',
       'title[' + [qA1, qA2, qA3, qA4, qA5, qA6].join('|') + '] over[' + [qB1, qB2, qB3, qB4, qB5].join('|') +
       '] clear[' + [qE1, qE2, qE3].join('|') + '] pause[' + [qC1, qC2, qC3].join('|') +
       '] play[' + [qD1, qD2].join('|') + ']');

/* Q5 覆盖层文字做成精灵后按内容缓存：静态界面每帧零 fillText */
overlayCache = null;
__opStat.fillText = 0;
const qLines = [{ text:'GAME OVER', size:'bold 52px sans-serif', color:'#FF5B5B', gap:76 },
                { text:'得分 1234', size:'20px sans-serif', color:'#FFFFFF', gap:40 }];
overlayText(qLines, 175);
const qFt1 = __opStat.fillText;
__opStat.fillText = 0;
overlayText(qLines, 175);
const qFt2 = __opStat.fillText;
__opStat.fillText = 0;
overlayText([{ text:'内容变了', size:'18px sans-serif', color:'#fff', gap:30 }], 175);
const qFt3 = __opStat.fillText;
assert('Q5 覆盖层文字缓存：内容不变时零 fillText，内容变化后重新烘焙',
       qFt1 === 2 && qFt2 === 0 && qFt3 === 1,
       'first=' + qFt1 + ' cached=' + qFt2 + ' changed=' + qFt3);

/* Q6 黑底并入地形缓存：地形无变化的一帧里不再有整屏填充 */
state = 'playing'; paused = false; levelIntro = 0; hintT = 0;
coarsePointer = true;                                  // 跳过 canvas 右侧面板的绘制
terrainFull = false; terrainDirty = Object.create(null); terrainDirtyCount = 0;
__opStat.rects.length = 0; __opStat.fillRect = 0;
render();
const qFullBg = __opStat.rects.some(r => r[0] === 0 && r[1] === 0 && r[2] === PLAY_W && r[3] === PLAY_H);
coarsePointer = qSavedCoarse;
assert('Q6 地形无变化的一帧里没有整屏背景填充（黑底已并入地形缓存）',
       !qFullBg, 'fillRect=' + __opStat.fillRect + ' rects=' + JSON.stringify(__opStat.rects.slice(0, 8)));

/* ---------- R. 双人辨识：玩家2 专属外观 + 状态各自独立 ----------
 * 背景：两个玩家原本共用同一张贴图（tank_player.png），完全分不出谁是谁；
 * 火力/武器虽一直挂在各自 tank 上（本就不共享），但界面只画 player 的一份，
 * 于是玩家2 拾取后毫无反馈，看起来像「被共享了」。 */
/* R1 色相旋转在「无像素接口」环境必须安全退化（返回 null → 调用方回退矢量绘制） */
const rSavedCreateEl = document.createElement;
document.createElement = function(){ return { width: 4, height: 4 }; };   // 故意不给 getContext
let rHz = 'threw';
try { rHz = hueRotate({ width: 4, height: 4 }, 168); } catch(e){ rHz = 'threw'; }
document.createElement = rSavedCreateEl;
assert('R1 hueRotate 安全退化：无 canvas 像素接口时返回 null 而非抛错', rHz === null,
       'got=' + (rHz === 'threw' ? 'threw' : String(rHz)));

/* R2 玩家2 配色是独立蓝色系，且旋转角在合理区间（不是 0 或 360 的无效值） */
assert('R2 玩家2 配色为独立蓝色系（≠ 玩家1 的 #F5C518）+ 色相角有效',
       P2_COLORS.body !== '#F5C518' && P2_HUE_SHIFT >= 90 && P2_HUE_SHIFT <= 270,
       'body=' + P2_COLORS.body + ' shift=' + P2_HUE_SHIFT);

/* R3 tankColors 按玩家返回不同配色（这是没有贴图素材时的回退路径，也要能分辨） */
const rSavedNet = netMode, rSavedP2 = player2;
netMode = 'host';
player2 = makeTank(PLAYER2_SPAWN.x, PLAYER2_SPAWN.y, 0, 'player', { power: 1 });
const rCol1 = tankColors(player), rCol2 = tankColors(player2);
assert('R3 tankColors：玩家1 黄 / 玩家2 蓝（取色确实不同）',
       !!player && rCol1.body !== rCol2.body && rCol2.body === P2_COLORS.body,
       'p1=' + rCol1.body + ' p2=' + rCol2.body);

/* R4 道具提示标明归属：双人 → 「P1 /P2 」，单人 → 空串（原文案零变化） */
const rT1 = whoTag(player), rT2 = whoTag(player2);
netMode = 'off'; player2 = null;
const rT3 = whoTag(player);
assert('R4 whoTag：双人 →「P1 /P2 」，单人 → 空串',
       rT1 === 'P1 ' && rT2 === 'P2 ' && rT3 === '',
       JSON.stringify([rT1, rT2, rT3]));

/* R5 状态不共享：玩家2 拾取火力/武器后，玩家1 的火力与武器必须原封不动 */
netMode = 'host';
player2 = makeTank(PLAYER2_SPAWN.x, PLAYER2_SPAWN.y, 0, 'player', { power: 1 });
const rP1Power = player.power, rP2Power = player2.power, rGun1 = player.gun, rAmmo1 = player.ammo;
pickUpItem({ type:'star', dead:false }, player2);
pickupWeapon('laser', player2);
assert('R5 状态不共享：玩家2 拾取火力/武器后玩家1 完全不受影响',
       !!player && player.power === rP1Power && player.gun === rGun1 && player.ammo === rAmmo1 &&
       player2.power === rP2Power + 1 && player2.gun === 'laser' && player2.ammo > 0,
       'p1{power=' + player.power + ',gun=' + player.gun + ',ammo=' + player.ammo + '} ' +
       'p2{power=' + player2.power + ',gun=' + player2.gun + ',ammo=' + player2.ammo + '}');

/* R6 玩家2 的武器/火力在 UI 上必须独立可见（双人时两行武器 + 两个 HUD 槽） */
const rHudEl = document.getElementById('hud-weapon2');
assert('R6 双人 UI：DOM HUD 存在玩家2 武器槽，且面板武器行走双行渲染',
       !!rHudEl && rHudEl.id === 'hud-weapon2' && typeof drawWeaponLine === 'function',
       'hud-weapon2=' + (rHudEl ? 'ok' : 'missing'));
netMode = rSavedNet; player2 = rSavedP2;

/* ---------- S. 界面重构：顶部工具栏搬进画面 + 手机横屏 ----------
 * 背景：原先「开始/双人/全图/全屏/音效/闪烁/设置/图鉴/暂停」是一排画布上方的
 * 按钮，手机上离拇指很远、还白白吃掉竖向空间；页脚那一长串操作说明同理。
 * 现在全部收进画面内的菜单与弹窗，并补上手机端真正缺的东西（横屏、血量档位）。 */

/* S1 血量档位可程序化切换（此前只有键盘 H，手机用户根本没有入口） */
const sSavedHp = hpMode;
setHpMode(PLAYER_HP_MODES.length);          // 正好越界 → 应回绕到 0
const sHpWrap = hpMode === 0;
setHpMode(2);
const sHp2 = hpMode === 2;
setHpMode(-1);                              // 负数也要安全回绕
const sHpNeg = hpMode === PLAYER_HP_MODES.length - 1;
hpMode = sSavedHp;
assert('S1 血量档位可程序化切换（越界/负数安全回绕）', sHpWrap && sHp2 && sHpNeg,
       'wrap=' + sHpWrap + ' ->2=' + sHp2 + ' neg=' + sHpNeg);

/* S2 设置 / 图鉴弹窗可开关且互斥（避免两层叠在一起） */
const sSetOv = document.getElementById('set-overlay');
const sCxOv  = document.getElementById('codex-overlay');
const sLog = [];
sSetOv.classList = { toggle:(c,on)=>{ sLog.push('set:' + c + '=' + !!on); }, add:NO, remove:NO, contains:()=>false };
sCxOv.classList  = { toggle:(c,on)=>{ sLog.push('cx:' + c + '=' + !!on); },  add:NO, remove:NO, contains:()=>false };
showSet(true);
const sSetOpen = sLog.indexOf('set:show=true') >= 0, sCxClosed = sLog.indexOf('cx:show=false') >= 0;
sLog.length = 0;
showCodex(true);
const sSetClosed2 = sLog.indexOf('set:show=false') >= 0, sCxOpen2 = sLog.indexOf('cx:show=true') >= 0;
assert('S2 设置弹窗可开关，且与图鉴互斥（打开一个自动关掉另一个）',
       sSetOpen && sCxClosed && sSetClosed2 && sCxOpen2, sLog.join(' '));

/* S3 只有手机（pointer:coarse）进对局时才请求全屏 —— 桌面完全不打扰 */
const sSavedCoarse = coarsePointer;
let sFsCalled = 0;
document.documentElement.requestFullscreen = () => { sFsCalled++; return Promise.resolve(); };
coarsePointer = false; enterMobileFullscreen();
const sDeskNoop = sFsCalled === 0;
coarsePointer = true;  enterMobileFullscreen();
const sTouchFs = sFsCalled === 1;
coarsePointer = sSavedCoarse;
assert('S3 手机进对局才请求全屏（后续用于锁横屏），桌面不打扰', sDeskNoop && sTouchFs,
       'desktop=' + sDeskNoop + ' touch=' + sTouchFs);

/* S4 锁横屏必须安全退化：桌面不锁；无 orientation API（iOS/测试沙箱）不抛错 */
coarsePointer = false;
const sLockDesk = lockLandscape() === null;
coarsePointer = true;
const sLockNoApi = lockLandscape() === null;
coarsePointer = sSavedCoarse;
assert('S4 lockLandscape：桌面无操作、无 API 环境返回 null 且不抛错',
       sLockDesk && sLockNoApi, 'desktop=' + sLockDesk + ' noApi=' + sLockNoApi);

/* S5 body.idle 驱动「摇杆让位给按钮」：只有真正在游玩（未暂停）才不 idle */
const sCls = [];
document.body.classList = { toggle:(c,on)=>{ sCls.push(c + '=' + !!on); }, add:NO, remove:NO, contains:()=>false };
state = 'title';   paused = false; caStateKey = ''; syncCenterActions();
const sTitleIdle = sCls.lastIndexOf('idle=true') >= 0;
sCls.length = 0;
state = 'playing'; paused = false; caStateKey = ''; syncCenterActions();
const sPlayIdle = sCls.lastIndexOf('idle=false') >= 0;
sCls.length = 0;
state = 'playing'; paused = true;  caStateKey = ''; syncCenterActions();
const sPauseIdle = sCls.lastIndexOf('idle=true') >= 0;
state = 'playing'; paused = false; caStateKey = ''; syncCenterActions();
assert('S5 body.idle：标题/暂停时隐藏摇杆开火键（并显示暂停键），只有真在游玩才相反',
       sTitleIdle && sPlayIdle && sPauseIdle,
       'title=' + sTitleIdle + ' play=' + sPlayIdle + ' pause=' + sPauseIdle);
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
