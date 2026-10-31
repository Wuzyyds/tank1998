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
  /* 竖屏闸门的 5 秒倒计时用 setInterval 起跳；沙箱里不必真的走秒，
   * 只要让它能注册成功，测试即可手动驱动 rotAutoStep() 逐拍推进。 */
  setInterval: () => 1,
  clearInterval: noop,
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
/* v1.7.0：老鹰道具从「60 秒无敌」改成「基地复活甲」—— 被打爆不再直接结算 */
baseRevive = 0; baseReviveT = 0; baseAlive = true; checkpointLevel = 0;
items.push({ x:player.x, y:player.y, px:player.px, py:player.py, type:'eagle', t:0 });
collectItems();
assert('D1 拾取老鹰 → 获得 1 次基地复活甲', baseRevive === 1 && baseReviveT === 0, 'revive=' + baseRevive);
destroyBase();
assert('D2 基地被打爆：不进入结算，转入 3 秒修复倒计时',
       state === 'playing' && baseAlive === false && Math.abs(baseReviveT - 3) < 1e-9,
       'state=' + state + ' alive=' + baseAlive + ' t=' + baseReviveT);
assert('D3 倒计时期间复活甲已消耗', baseRevive === 0, 'revive=' + baseRevive);
tickBaseRevive(3.1);
assert('D4 3 秒后基地自动修复（4 个 BASE 格写回）',
       baseAlive === true && map[24][12] === BASE && map[24][13] === BASE &&
       map[25][12] === BASE && map[25][13] === BASE && baseReviveT === 0,
       'alive=' + baseAlive + ' t=' + baseReviveT);
baseAlive = true; destroyBase();
assert('D5 复活甲用完：再次被打爆就真的结算', state === 'over' && baseRevive === 0, 'state=' + state);
state = 'playing'; checkpointLevel = 0;

/* ---------- v1.7.0 武器 / 道具调整 ---------- */
startGame();
enemyQueue.length = 0; enemies.length = 0; bullets.length = 0; items.length = 0;
for (let r = 4; r < 22; r++) for (let c = 2; c < 24; c++) map[r][c] = EMPTY;

/* 冲锋枪：对 1 血敌人要两枪；对玩家仍然一击必死（玩家只有 1 血，半伤会变成白送一条命） */
const smgE = makeTank(12, 8, 2, 'basic', { invuln: 0 });
enemies.push(smgE);
const mkHit = (t) => applyHit({ owner: player, gun: 'smg', power: 1, dead: false,
                                px: t.px, py: t.py, dir: 1, hitIds: null, pierceLeft: 0 }, t);
mkHit(smgE);
const smgHp1 = smgE.hp, smgDead1 = smgE.dead;
mkHit(smgE);
assert('冲锋枪：对 1 血敌人要两枪（第一枪只掉半血）',
       Math.abs(smgHp1 - 0.5) < 1e-9 && smgDead1 === false && smgE.dead === true,
       'firstHp=' + smgHp1 + ' firstDead=' + smgDead1 + ' secondDead=' + smgE.dead);
const smgDummy = makeTank(10, 14, 0, 'player', { invuln: 0 });
mkHit(smgDummy);
assert('冲锋枪：打到玩家仍是一击必死（低伤害只对敌人成立）',
       smgDummy.dead === true, 'dead=' + smgDummy.dead);
player.gun = 'smg'; player.ammo = 20;
assert('冲锋枪：射击间隔压到 0.2 秒（fireK 0.5 × 基础 0.4s）',
       Math.abs(fireCooldown(player) - 0.2) < 1e-9, 'cd=' + fireCooldown(player));
player.gun = 'normal'; player.ammo = 0;

/* 散弹枪：一次 5 发 */
bullets.length = 0; player.gun = 'spread'; player.ammo = 12; player.power = 1; player.dir = 1;
fireBullet(player);
assert('散弹枪：一次齐射 5 发', bullets.length === 5, 'n=' + bullets.length);
player.gun = 'normal'; player.ammo = 0;

/* 火焰枪：致死传染半径 2 格（正好 2 格要算进来） */
const burnSrc = makeTank(10, 10, 0, 'basic', { invuln: 0 });
const burnNear = makeTank(11, 10, 0, 'basic', { invuln: 0 });
const burnEdge = makeTank(12, 10, 0, 'basic', { invuln: 0 });
const burnFar = makeTank(13, 10, 0, 'basic', { invuln: 0 });
enemies = [burnSrc, burnNear, burnEdge, burnFar];
spreadBurn(burnSrc);
assert('火焰枪：致死传染覆盖 2 格内（边界 2 格也算），第 3 格不传染',
       burnNear.burnT > 0 && burnEdge.burnT > 0 && burnFar.burnT === 0,
       'near=' + burnNear.burnT + ' edge=' + burnEdge.burnT + ' far=' + burnFar.burnT);

/* 钢板：基地外围砖 → 钢，25 秒后变回砖 */
startGame();
enemyQueue.length = 0; enemies.length = 0;
let fortCell = null;
for (let r = 22; r <= 25 && !fortCell; r++){
  for (let c = 10; c <= 15; c++){ if (map[r][c] === BRICK){ fortCell = [r, c]; break; } }
}
assert('钢板：基地外围有砖墙可作为加固对象', !!fortCell, 'cell=' + JSON.stringify(fortCell));
applyFortify();
assert('钢板：外围砖被换成钢，计时 25 秒',
       !!fortCell && map[fortCell[0]][fortCell[1]] === STEEL && fortifyT === 25,
       'tile=' + (fortCell && map[fortCell[0]][fortCell[1]]) + ' t=' + fortifyT);
tickFortify(25.1);
assert('钢板：25 秒后变回砖（不是凭空消失）',
       !!fortCell && map[fortCell[0]][fortCell[1]] === BRICK && fortifyT === 0,
       'tile=' + (fortCell && map[fortCell[0]][fortCell[1]]) + ' t=' + fortifyT);

/* 命数上限 8 */
startGame();
lives = 7;
items.length = 0; items.push({ x:player.x, y:player.y, px:player.px, py:player.py, type:'tank', t:0 });
collectItems();
const livesOnce = lives;
items.length = 0; items.push({ x:player.x, y:player.y, px:player.px, py:player.py, type:'tank', t:0 });
collectItems();
assert('坦克道具：命数上限为 8（原 6）',
       livesOnce === 8 && lives === MAX_LIVES, 'after8=' + livesOnce + ' cap=' + MAX_LIVES);

/* ---------- E. 子弹对撞（v1.6.10：同级互消，不同级时强弹无损） ---------- */
startGame();
enemyQueue.length = 0; enemies.length = 0; bullets.length = 0;
for (let c = 0; c < COLS; c++) map[5][c] = 0;
const E = makeTank(12, 5, 3, 'basic', {});
/* 构造一对迎面对撞的子弹，跑到分出结果为止（速度用真实公式，别写死） */
function clash(pp, ep){
  bullets.length = 0;
  bullets.push({ px:200, py:110, dir:1, speed:bulletSpeed(player, pp), owner:player, dead:false, power:pp });
  bullets.push({ px:260, py:110, dir:3, speed:bulletSpeed(E, ep),      owner:E,      dead:false, power:ep });
  for (let i = 0; i < 60 && bullets.filter(b => !b.dead).length > 1; i++) updateBullets(0.02);
  return bullets.filter(b => !b.dead);
}
let r = clash(1, 1);
assert('E1 1v1 同归于尽', r.length === 0, '存活=' + r.length);
r = clash(2, 2);
assert('E2 2v2 同归于尽', r.length === 0, '存活=' + r.length);
r = clash(3, 3);
assert('E2b 3v3 同归于尽', r.length === 0, '存活=' + r.length);
r = clash(2, 1);
assert('E3 2v1 → 强弹无损存活（等级仍为 2，原规则会降到 1）',
       r.length === 1 && r[0].power === 2 && r[0].owner === player,
       '存活=' + r.length + ' power=' + (r[0] && r[0].power));
r = clash(3, 1);
assert('E4 3v1 → 强弹仍为 3 级（原规则会降到 2）', r.length === 1 && r[0].power === 3,
       'power=' + (r[0] && r[0].power));
r = clash(3, 2);
assert('E5 3v2 → 强弹仍为 3 级（原规则会降到 1）', r.length === 1 && r[0].power === 3,
       'power=' + (r[0] && r[0].power));
r = clash(3, 1);
assert('E6 对撞不改变强弹速度（等级不变 → 速度不变）',
       r.length === 1 && Math.abs(r[0].speed - bulletSpeed(player, 3)) < 1e-6,
       'speed=' + (r[0] && r[0].speed));
/* 用户报的场景：1 级玩家弹撞 3 级敌弹，弱弹必须彻底无效 */
r = clash(1, 3);
assert('E10 1 级弹撞 3 级弹 → 弱弹消失、强弹等级与速度都不变',
       r.length === 1 && r[0].power === 3 && r[0].owner === E &&
       Math.abs(r[0].speed - bulletSpeed(E, 3)) < 1e-6,
       '存活=' + r.length + ' power=' + (r[0] && r[0].power) + ' owner=' + (r[0] && (r[0].owner === E ? 'E' : 'P')));
/* 同阵营互不干扰：否则 power3 的两发弹会自己撞自己，升级反而变成自我消耗 */
bullets.length = 0;
bullets.push({ px:200, py:110, dir:1, speed:260, owner:player, dead:false, power:3 });
bullets.push({ px:230, py:110, dir:1, speed:305, owner:player, dead:false, power:1 });
for (let i = 0; i < 6; i++) updateBullets(0.02);
assert('E7 同阵营子弹互不干扰', bullets.filter(b => !b.dead).length === 2 &&
       bullets[0].power === 3 && bullets[1].power === 1,
       '存活=' + bullets.filter(b => !b.dead).length);
/* 弹幕里连续交火：强弹也不会被削级（原规则靠 clashCd 限速，现在压根不降级） */
bullets.length = 0;
const many = [];
for (let i = 0; i < 4; i++) many.push({ px:240 + i*9, py:110, dir:3, speed:240, owner:E, dead:false, power:1 });
bullets.push({ px:200, py:110, dir:1, speed:350, owner:player, dead:false, power:3 });
bullets.push(...many);
for (let i = 0; i < 20; i++) updateBullets(0.02);
const surv = bullets.filter(b => !b.dead && b.owner === player);
assert('E8 连撞 4 发 1 级弹后，3 级弹仍为 3 级（不再降级）',
       surv.length === 1 && surv[0].power === 3, 'power=' + (surv[0] && surv[0].power));
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
assert('H3 敌人吃时钟 = 冻玩家 5 秒', Math.abs(freezePlayer - 5) < 1e-9, 'freezePlayer=' + freezePlayer);
EH.amphibious = 0; give(EH, 'amphibious');
assert('H4 敌人吃两栖 = 40 秒', Math.abs(EH.amphibious - 40) < 1e-9, 'amph=' + EH.amphibious);
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

/* ---------- J. 血量与血条 ----------
 * v1.6.0：血量档位已删除，玩家固定 1 血（一击必死），容错改由难度承担。
 * 多血机制本身仍保留给「显式设了 maxHp 的单位」，这里一并锁住不回归。 */
assert('J1 玩家固定 1 血（血量档位已并入难度）', playerMaxHp() === 1, 'hp=' + playerMaxHp());
const P2 = makeTank(8, 24, 0, 'player', {});
assert('J2 玩家坦克出生即 1 血', P2.maxHp === 1 && P2.hp === 1, 'hp=' + P2.hp + '/' + P2.maxHp);
P2.invuln = 0; damageTank(P2, 1, 'bullet');
assert('J3 玩家挨一发即死（一击必死）', P2.dead === true, 'dead=' + P2.dead);
/* 多血单位：非致命受击补 1 秒无敌，否则连击会瞬间打穿 */
const MT = makeTank(8, 24, 0, 'player', {}); MT.maxHp = 3; MT.hp = 3; MT.invuln = 0;
damageTank(MT, 1, 'bullet');
assert('J4 多血单位非致命受击 → 扣 1 血并进入 1 秒无敌',
       MT.dead === false && MT.hp === 2 && MT.invuln > 0.9,
       'hp=' + MT.hp + ' invuln=' + MT.invuln.toFixed(2));
MT.invuln = 0; damageTank(MT, 1, 'bullet');
assert('J4b 再挨一发才到 1 血（仍未死）', MT.dead === false && MT.hp === 1, 'hp=' + MT.hp);
const ARM = makeTank(6, 6, 2, 'armor', {});
assert('J5 armor 仍为 4 血', ARM.maxHp === 4, 'hp=' + ARM.maxHp);
const PW = makeTank(6, 6, 2, 'power', {});
assert('J6 power 型敌人提升到 2 血', PW.maxHp === 2, 'hp=' + PW.maxHp);
/* 渲染冒烟：带武器/血条/状态时不抛异常 */
startGame(); levelIntro = 0;
player.gun = 'laser'; player.ammo = 3; player.burnT = 1.2; player.slowT = 2; player.hitFlash = 0.1;
player.maxHp = 3; player.hp = 2;   // 手动造出多血血条，覆盖 drawHpPips 渲染路径
enemies.push(makeTank(6, 6, 2, 'armor', {}));
items.push({ x:5, y:5, px:110, py:110, type:'flame', t:0 });
items.push({ x:7, y:5, px:150, py:110, type:'tesla', t:0 });
grenadeBlasts.push({ px:200, py:200, t:0.8, r:60 });
let renderOK = true; try { for (let i = 0; i < 30; i++){ update(0.016); render(); } } catch(e){ renderOK = e.message; }
assert('J7 带武器/血条/状态/手雷警示渲染 30 帧不抛异常', renderOK === true, String(renderOK));

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
 * 现在全部收进画面内的菜单与弹窗，并补上手机端真正缺的东西（横屏、难度选择）。 */

/* S1 难度可选（1~5）且越界/负数安全回绕 —— 取代原先只能靠键盘 H 切的「血量档位」 */
const sSavedDiff = startDiff;
setDiffStart(TIERS.length + 1);             // 越界 → 回绕到 1
const sDiffWrap = startDiff === 1;
setDiffStart(3);
const sDiff3 = startDiff === 3;
setDiffStart(-1);                           // 负数也要安全落在 1~5
const sDiffNeg = startDiff >= 1 && startDiff <= TIERS.length;
setDiffStart(sSavedDiff);
assert('S1 难度可程序化选择（越界/负数安全回绕到 1~5）', sDiffWrap && sDiff3 && sDiffNeg,
       'wrap=' + sDiffWrap + ' ->3=' + sDiff3 + ' neg=' + sDiffNeg);

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

/* ---------- T. 难度 1~5（每级 5 关、第 5 关 BOSS）+ 过关自动继续 ---------- */

/* T1 难度 ↔ level 区间映射：难度不新增字段，直接由 level 反推 */
const tMap = [];
for (const pair of [[1,1],[5,1],[6,2],[10,2],[11,3],[25,5]]){
  level = pair[0];
  tMap.push(pair[0] + ':' + curDiff() + '-' + stageInDiff());
}
assert('T1 难度由 level 反推：难度 N 覆盖 level (N-1)*5+1 ~ N*5',
       tMap.join(' ') === '1:1-1 5:1-5 6:2-1 10:2-5 11:3-1 25:5-5', tMap.join(' '));

assert('T2 每级恰好 5 关、共 25 关，且每级第 5 关为 BOSS 关',
       diffTotalLevels() === 25 && TIERS.length === 5 &&
       [5,10,15,20,25].every(l => { level = l; return isBossLevel(); }) &&
       [1,2,3,4,6,11,24].every(l => { level = l; return !isBossLevel(); }),
       'total=' + diffTotalLevels() + ' tiers=' + TIERS.length);

/* T3 从标题页选定的难度开始 */
setDiffStart(3);
startGame();
const tStart = { lvl: level, diff: curDiff(), tier: tier().name };
assert('T3 startGame 从选定难度开始（难度 3 → level 11 · 精锐）',
       tStart.lvl === 11 && tStart.diff === 3 && tStart.tier === '精锐', JSON.stringify(tStart));

/* T4 过关推进 + level 在 1..25 循环 */
level = 5;  nextLevel();
const tNext = { lvl: level, diff: curDiff() };
level = 25; nextLevel();
const tWrap = { lvl: level, diff: curDiff() };
assert('T4 过关推进：第 5 关后进入难度 2；难度 5 的第 5 关后回到难度 1',
       tNext.lvl === 6 && tNext.diff === 2 && tWrap.lvl === 1 && tWrap.diff === 1,
       'next=' + JSON.stringify(tNext) + ' wrap=' + JSON.stringify(tWrap));

/* T5 过关界面自动继续：进入 clear 带倒计时，倒计时耗尽自动推进 */
netMode = 'off'; setDiffStart(1); startGame(); levelIntro = 0;
level = 2;                              // 用普通关，避开「难度通关」分支
enemyQueue.length = 0; enemies.length = 0;
for (let i = 0; i < 3; i++) update(0.05);
const tClear = { state: state, hold: clearHoldT, lvl: level };
update(CLEAR_HOLD_SEC + 0.2);
const tAuto = { state: state, lvl: level, hold: clearHoldT };
assert('T5 过关后进入 clear，倒计时耗尽自动进入下一关',
       tClear.state === 'clear' && tClear.hold > 0 &&
       tAuto.state === 'playing' && tAuto.lvl === tClear.lvl + 1 && tAuto.hold === 0,
       'clear=' + JSON.stringify(tClear) + ' auto=' + JSON.stringify(tAuto));

/* T6 暂停时倒计时冻结（避免暂停中「偷偷过关」） */
startGame(); levelIntro = 0;
enemyQueue.length = 0; enemies.length = 0;
for (let i = 0; i < 3; i++) update(0.05);
const tHold0 = clearHoldT;
paused = true;
update(1.0);
const tFrozen = (clearHoldT === tHold0);
paused = false;
assert('T6 暂停时过关倒计时冻结，不会偷偷推进关卡',
       state === 'clear' && tHold0 > 0 && tFrozen, 'hold=' + tHold0 + ' -> ' + clearHoldT);

/* T7 联机客方不自行推进关卡（场景切换一律由房主推进、快照跟随） */
startGame(); levelIntro = 0;
enemyQueue.length = 0; enemies.length = 0;
for (let i = 0; i < 3; i++) update(0.05);
const tGuestLvl = level;
netMode = 'guest';
update(CLEAR_HOLD_SEC + 1.0);
const tGuestStayed = (level === tGuestLvl && state === 'clear');
netMode = 'off';
assert('T7 联机客方不自动推进关卡（由房主推进、快照跟随）', tGuestStayed,
       'lvl=' + level + ' state=' + state);

/* T8 过关文案三种：普通关 / 难度通关 / 全难度通关 */
const tTexts = (function(){
  const c = canvas.getContext('2d'); const orig = c.fillText; const rec = [];
  c.fillText = function(t){ rec.push(String(t)); };
  level = 4; clearHoldT = 3; drawClear(); const normal = rec.slice();
  rec.length = 0;
  level = 5; drawClear(); const boss = rec.slice();
  rec.length = 0;
  level = 25; drawClear(); const last = rec.slice();
  c.fillText = orig;
  return { normal: normal, boss: boss, last: last };
})();
assert('T8 过关文案分三种：普通关 / 难度通关 / 全难度通关',
       tTexts.normal.some(t => /难度 1 · 第 4 关 完成/.test(t)) &&
       !tTexts.normal.some(t => /通关/.test(t)) &&
       tTexts.boss.some(t => /难度 1 通关/.test(t)) &&
       tTexts.last.some(t => /全部难度通关/.test(t)),
       JSON.stringify(tTexts).slice(0, 180));

/* T9 转向即时：移动中改方向，下一帧就生效。
 * 原实现一律「走完当前格再转向」——一格耗时 = TILE20 ÷ 52px/s ≈ 385ms，
 * 也就是按下方向键后坦克最多还会沿原方向再跑 0.38s 才拐弯（按反方向掉头同理），
 * 这是「游戏本身就操作不流畅」的主因，也是本次修复的核心。 */
netMode = 'off'; setDiffStart(1); startGame(); levelIntro = 0; freezePlayer = 0;
enemies.length = 0; enemyQueue.length = 0; bullets.length = 0;
for (let ty = 4; ty <= 16; ty++) for (let tx = 4; tx <= 16; tx++) map[ty][tx] = EMPTY;
player = makeTank(10, 10, 1, 'player', {invuln:0, power:1});
keys = { ArrowRight: true };
updatePlayer(0.05); updatePlayer(0.05);          // 向右走 2 帧（约 5px，仍在第 10 格内）
const t9a = { dir: player.dir, px: player.px, moving: !!player.movingTo };
keys = { ArrowUp: true };                        // 半格处改向上
updatePlayer(0.016);
const t9b = { dir: player.dir, px: player.px, py: player.py, x: player.x, y: player.y };
assert('T9 转向即时：移动中改方向下一帧即生效（原实现要等走完当前格 ≈385ms）',
       t9a.dir === 1 && t9a.moving && t9b.dir === 0,
       'before=' + JSON.stringify(t9a) + ' after=' + JSON.stringify(t9b));

/* T9b 但新方向前方被墙挡住时，必须退回「走到格心再转」——立即转向不能退化成
 * 「一按就贴墙」，那样反而是手感倒退。两种情况都要保住。 */
map[9][10] = BRICK;                              // 玩家正上方封住
player.dir = 1; player.pendingDir = null;
player.x = 10; player.y = 10; player.px = 10*TILE + TILE/2; player.py = 10*TILE + TILE/2;
player.movingTo = { x: 11, y: 10 };
keys = { ArrowRight: true };
updatePlayer(0.05);
keys = { ArrowUp: true };
updatePlayer(0.016);
const t9c = { dir: player.dir, pending: player.pendingDir };
assert('T9b 新方向被墙挡住时退回输入缓冲（保留「在下一个路口转弯」的手感）',
       t9c.dir === 1 && t9c.pending === 0, JSON.stringify(t9c));

/* T10 客方本地预测：客方不跑模拟，位置原先只能等房主快照（一个来回 ≈70ms 起），
 * 按方向键到屏幕上有反应有明显滞后。预测让「按键」立刻在画面上生效。 */
netMode = 'guest'; coopReady = true; coopDropped = false; paused = false;
state = 'playing'; freezePlayer = 0;
for (let ty = 4; ty <= 16; ty++) for (let tx = 4; tx <= 16; tx++) map[ty][tx] = EMPTY;
player2 = makeTank(8, 12, 1, 'player', {invuln:0, power:1});
keys2 = { ArrowDown: true };
const t10y0 = player2.py;
for (let i = 0; i < 6; i++) predictGuestPlayer2(0.05);   // 期间没有任何快照
assert('T10 客方本地预测：无新快照时按方向键，画面上的玩家2 也会立刻响应',
       player2.py > t10y0, 'py ' + t10y0 + ' -> ' + player2.py);

/* T11 预测对账：偏差小就保留本地预测结果（若每个快照都无脑覆盖，画面会被
 * 30Hz 的权威位置反复拽回去，反而看出抖动）；偏差大（重生 / 换关 / 被卡住）
 * 必须采纳房主的权威值。 */
const t11 = (function(){
  const mkSnap = () => ({
    s:'playing', lvl:1, score:0, lives:2, lives2:2, fe:0, fp:0, pe:0, li:0, base:1,
    p: tankArr(player), p2: tankArr(player2), e:[], b:[], it:[], ex:[], gb:[],
  });
  player2.px = 170; player2.py = 250;
  const s1 = mkSnap();
  s1.p2[TANK_F.indexOf('px')] = 173;             // 与本地预测只差 3px
  applySnapshot(s1);
  const near = player2.px;
  const s2 = mkSnap();
  s2.p2[TANK_F.indexOf('px')] = 370;             // 差 200px：明显分歧
  applySnapshot(s2);
  return { near: near, far: player2.px };
})();
assert('T11 预测对账：小偏差保留本地预测（不抖），大偏差才回落到房主权威位置',
       Math.abs(t11.near - 170) < 1 && Math.abs(t11.far - 370) < 1, JSON.stringify(t11));
/* T12 涡轮加速道具（v1.6.2 新增）：拾取 → 移速 ×1.5 → 同样帧数走得更远 → 计时结束自动失效。
 * 与「减速」同路：只乘在实际位移上（不动 t.speed），否则会每帧反复相乘而漂移。 */
netMode = 'off'; paused = false; startGame(); levelIntro = 0; freezePlayer = 0;
enemies.length = 0; enemyQueue.length = 0; bullets.length = 0; items.length = 0;
for (let ty = 8; ty <= 14; ty++) for (let tx = 8; tx <= 16; tx++) map[ty][tx] = EMPTY;
player = makeTank(10, 10, 1, 'player', {invuln:0, power:1});
const t12Mul0 = statusSpeedMul(player);
items.push({ x:10, y:10, px:player.px, py:player.py, type:'speed', t:0 });
collectItems();
const t12 = { speedT: player.speedT, mul: statusSpeedMul(player), speed: player.speed };
assert('T12 拾取涡轮 → speedT=30（玩家）、移速 ×1.5，且不改 t.speed 本身',
       Math.abs(t12.speedT - SPEED_TIME) < 1e-9 && Math.abs(t12.mul - SPEED_MUL_P) < 1e-9 &&
       t12Mul0 === 1 && Math.abs(t12.speed - PLAYER_SPEED) < 1e-9, JSON.stringify(t12));

/* T12b 同样 6 帧、同样按键：加速后位移明显更远 */
function t12Reset(st){
  player.x = 10; player.y = 10; player.px = 10*TILE + TILE/2; player.py = 10*TILE + TILE/2;
  player.dir = 1; player.movingTo = null; player.pendingDir = null; player.speedT = st;
}
t12Reset(0); keys = { ArrowRight: true };
for (let i = 0; i < 6; i++) updatePlayer(0.05);
const t12Slow = player.px;
t12Reset(SPEED_TIME);
for (let i = 0; i < 6; i++) updatePlayer(0.05);
const t12Fast = player.px;
assert('T12b 加速期间同样帧数位移明显更远（1.5 倍速真的落到移动上）',
       t12Fast > t12Slow + 5, '慢=' + t12Slow.toFixed(1) + ' 快=' + t12Fast.toFixed(1));

/* T12c 计时结束自动失效 */
keys = {}; player.speedT = 0.5; player.slowT = 0; tickStatus(player, 0.6);
assert('T12c 加速计时归零后倍率恢复 1',
       player.speedT === 0 && statusSpeedMul(player) === 1, 'speedT=' + player.speedT);

/* T12d 敌人侧倍率低于玩家（否则永远追不上、也逃不掉） */
const t12e = makeTank(6, 6, 2, 'basic', {});
t12e.speedT = ENEMY_SPEED_TIME;
assert('T12d 普通敌人吃加速 → ×1.3 / 12 秒（低于玩家的 ×1.5 / 30 秒）',
       Math.abs(statusSpeedMul(t12e) - ENEMY_SPEED_MUL) < 1e-9 &&
       statusSpeedMul(t12e) < SPEED_MUL_P && ENEMY_SPEED_TIME < SPEED_TIME,
       'mul=' + statusSpeedMul(t12e));

/* T12e 走快照协议：TANK_F 必须登记 speedT，否则联机时客方看不到自己的加速 */
assert('T12e speedT 已进 TANK_F 且与 tankArr 等长（联机不丢字段）',
       TANK_F.indexOf('speedT') >= 0 && TANK_F.length === tankArr(player).length &&
       Math.abs(arrTank(tankArr(player)).speedT - player.speedT) < 1e-9,
       'TANK_F=' + TANK_F.length + ' arr=' + tankArr(player).length);

/* T12f 玩家时长 30 秒（v1.6.3 由 20 秒上调） */
assert('T12f 玩家涡轮时长 30 秒（20 秒偏短）', SPEED_TIME === 30, 'SPEED_TIME=' + SPEED_TIME);

/* T12g 快速兵（速度兵）走绝对加成：+0.75 格/秒（不是倍率）、15 秒。
 * 关键：加速后的有效速度必须正好等于 speed + 0.75，且**低于**原先 ×1.3 的路径
 * （否则快速兵会到 5.8 ~ 7.9 格/秒，玩家加速后也只有 3.9，逃不掉）。 */
const t12FastKind = makeTank(6, 6, 2, 'fast', {});
t12FastKind.speedT = FAST_SPEED_TIME;
const t12FastEff = t12FastKind.speed * statusSpeedMul(t12FastKind);
assert('T12g 快速兵吃涡轮 → 速度 +0.75 格/秒（绝对加成）/ 15 秒',
       Math.abs(t12FastEff - (t12FastKind.speed + FAST_SPEED_ADD)) < 1e-9 &&
       FAST_SPEED_TIME === 15 && Math.abs(FAST_SPEED_ADD - 0.75) < 1e-9 &&
       t12FastEff < t12FastKind.speed * ENEMY_SPEED_MUL,
       'eff=' + t12FastEff.toFixed(3) + ' base=' + t12FastKind.speed.toFixed(3));

/* T12h 快速兵专属：必须不走 1.3 倍的倍率路径 */
assert('T12h 快速兵不吃 1.3 倍率路径（专属分支生效）',
       Math.abs(statusSpeedMul(t12FastKind) - ENEMY_SPEED_MUL) > 1e-6,
       'mul=' + statusSpeedMul(t12FastKind));

/* T12i 其它敌人不受影响（basic / power 仍 ×1.3 / 12 秒），并验证拾取分支给的时长 */
enemies.length = 0; items.length = 0; keys = {};
const t12Basic = makeTank(6, 6, 2, 'basic', {});
const t12Power = makeTank(7, 6, 2, 'power', {});
const t12It = { type:'speed' };
pickUpItem(t12It, t12Basic);
pickUpItem({ type:'speed' }, t12Power);
t12FastKind.speedT = 0;
pickUpItem({ type:'speed' }, t12FastKind);
assert('T12i 拾取分支：普通/火力兵 12 秒，快速兵 15 秒',
       t12Basic.speedT === ENEMY_SPEED_TIME && t12Power.speedT === ENEMY_SPEED_TIME &&
       t12FastKind.speedT === FAST_SPEED_TIME &&
       Math.abs(statusSpeedMul(t12Basic) - ENEMY_SPEED_MUL) < 1e-9,
       'basic=' + t12Basic.speedT + ' power=' + t12Power.speedT + ' fast=' + t12FastKind.speedT);

/* T13 客方开火本地预测（v1.6.2）：客方开火原本只能等房主快照（一个来回 ≈120ms），
 * 按下开火有明显空档。现在本地立刻生成曳光弹，房主权威子弹到位即交还。 */
netMode = 'guest'; coopReady = true; coopDropped = false; paused = false;
state = 'playing'; freezePlayer = 0; gameTime = 0;
for (let ty = 8; ty <= 16; ty++) for (let tx = 8; tx <= 20; tx++) map[ty][tx] = EMPTY;
player2 = makeTank(12, 12, 1, 'player', {invuln:0, power:1});
player2.bulletCd = 0; player2.overheatT = 0; player2.gun = 'normal'; player2.ammo = 0;
bullets = []; predBullets.length = 0;
keys2 = { Space: true };
predictGuestPlayer2(0.016);
const t13a = { n: predBullets.length, px: predBullets[0] ? predBullets[0].px : -1 };
for (let i = 0; i < 4; i++) predictGuestPlayer2(0.016);
assert('T13 客方按开火 → 立刻在画面上生成曳光弹并向前飞（完全不等房主快照）',
       t13a.n === 1 && predBullets.length === 1 && predBullets[0].px > t13a.px,
       'n=' + t13a.n + ' px ' + t13a.px + ' -> ' + (predBullets[0] && predBullets[0].px));

/* T13b 对账：房主权威子弹一到位就把曳光弹交出去（否则同一发会画两遍） */
const t13pb = predBullets[0];
bullets = [{ px: t13pb.px + 2, py: t13pb.py, dir: t13pb.dir, ang: t13pb.ang, power: t13pb.power,
             gun: t13pb.gun, owner: { isPlayer: true, tag: 2 }, dead: false }];
reconcilePredBullets();
assert('T13b 房主子弹到位 → 曳光弹交还权威（同一发不会画两遍）',
       predBullets.length === 0, 'n=' + predBullets.length);

/* T13c 房主一直没放行时不产生「鬼弹」：曳光弹按生命周期自动淡出 */
predBullets.length = 0; bullets = []; keys2 = { Space: true };
player2.bulletCd = 0; player2.overheatT = 0;
predictGuestFire(0.016);
const t13n1 = predBullets.length;
for (let i = 0; i < 40; i++) updatePredBullets(0.016);   // 0.64 秒
assert('T13c 曳光弹有生命周期上限（0.3 秒）：房主未放行也不会留下打不中的「鬼弹」',
       t13n1 === 1 && predBullets.length === 0, 'n1=' + t13n1 + ' -> ' + predBullets.length);

/* T13d 同屏弹数上限与房主一致（= power），本地曳光弹也计入 */
predBullets.length = 0; bullets = []; keys2 = { Space: true };
player2.bulletCd = 0; player2.overheatT = 0; player2.power = 1;
predictGuestFire(0.016);
player2.bulletCd = 0;
predictGuestFire(0.016);          // 第 2 发应被「同屏弹数 = power」挡住
assert('T13d 本地预测同样遵守「同屏弹数 = 火力等级」', predBullets.length === 1, 'n=' + predBullets.length);

/* T13e 客方开火本地音效 —— 补掉老问题：sfx.shoot() 只在 fireBullet()（仅房主执行）里调用，
 * 客方此前全程听不到自己的开火声。这里直接盯 predictGuestFire 是否请求了开火音效
 * （换成盯 sfxRaw 会撞上节流：gameTime 在 T13 里被重置过，节流记录来自更早的用例）。 */
let t13Sfx = 0;
const t13OrigShoot = sfx.shoot;
sfx.shoot = function(){ t13Sfx++; };
predBullets.length = 0; bullets = []; keys2 = { Space: true }; player2.bulletCd = 0;
predictGuestFire(0.016);
sfx.shoot = t13OrigShoot;
assert('T13e 客方开火在本地播放音效（此前客方全程无声）', t13Sfx === 1, 'n=' + t13Sfx);

/* T13f 子弹快照带拥有者标签：客方要认出哪几发是自己的（2=P2 / 1=P1 / 0=敌） */
const t13TagP2 = bulletArr({ px:0, py:0, dir:0, ang:0, power:1, gun:'normal', owner: player2, kind:null });
const t13TagP1 = bulletArr({ px:0, py:0, dir:0, ang:0, power:1, gun:'normal', owner: player,  kind:null });
const t13TagEn = bulletArr({ px:0, py:0, dir:0, ang:0, power:1, gun:'normal', owner: makeTank(3,3,2,'basic',{}), kind:null });
assert('T13f 子弹快照带拥有者标签（2=P2 / 1=P1 / 0=敌），客方才能认出自己的弹幕',
       t13TagP2[10] === 2 && t13TagP1[10] === 1 && t13TagEn[10] === 0 &&
       arrBullet(t13TagP2).owner.tag === 2,
       'p2=' + t13TagP2[10] + ' p1=' + t13TagP1[10] + ' en=' + t13TagEn[10]);

/* T13g 暂停 / 非对局 / 掉线时立即收掉曳光弹（不留残影） */
predBullets.length = 0; keys2 = { Space: true }; player2.bulletCd = 0;
predictGuestFire(0.016);
const t13res = predBullets.length;
paused = true;  predictGuestPlayer2(0.016); const t13P = predBullets.length;
paused = false; state = 'clear'; predictGuestPlayer2(0.016); const t13S = predBullets.length;
state = 'playing'; keys2 = { Space: true }; player2.bulletCd = 0;
predictGuestFire(0.016); const t13Pre = predBullets.length;
coopDropped = true; predictGuestPlayer2(0.016); const t13D = predBullets.length;
coopDropped = false;
assert('T13g 暂停 / 非对局 / 掉线时立即收掉曳光弹（不留残影）',
       t13res === 1 && t13P === 0 && t13S === 0 && t13Pre === 1 && t13D === 0,
       JSON.stringify({ res: t13res, paused: t13P, clear: t13S, dropped: t13D }));


/* ---------- U. 手机横屏：进入即全屏 + 横屏（v1.6.4） ----------
 * 原实现只有「开始游戏 / 双人游戏」两个按钮会触发，且只尝试一次、失败后无任何提示 ——
 * 手机上就表现为「画面一直是竖的、游戏区被压成中间一小块，还以为游戏坏了」。 */

/* U1 竖屏判定必须在任何环境里都有答案且不抛错（沙箱里 screen / window.orientation / innerWidth 全无） */
const uSavedCoarse = coarsePointer;
let uPortraitOk = false;
try { uPortraitOk = isPortraitViewport() === false; } catch (e) { uPortraitOk = false; }
assert('U1 竖屏判定在缺失 screen / window.orientation / innerWidth 的环境里不抛错且有默认答案',
       uPortraitOk, 'portrait=false? ' + uPortraitOk);

/* U2 锁方向要留退路：标准 API 先要 landscape-primary，被拒后退回 landscape。
 * 这里用一个「catch 同步回调」的假 Promise，免得断言要等微任务。 */
const uLockCalls = [];
const uSavedScreen = (typeof screen !== 'undefined') ? screen : undefined;
screen = { orientation: { type:'portrait-primary', lock: (v) => {
  uLockCalls.push(v);
  return { catch: (fn) => { if (v === 'landscape-primary') fn(); return { catch: () => {} }; } };
} } };
coarsePointer = false;
const uLockDesk = lockLandscape() === null && uLockCalls.length === 0;
coarsePointer = true;
lockLandscape();
const uLockSeq = uLockCalls.join(',');
assert('U2 锁横屏：桌面不动；触屏按 landscape-primary → landscape 依次退路',
       uLockDesk && uLockSeq === 'landscape-primary,landscape', uLockSeq);

/* U3 没有标准 lock 时走老前缀实现（老安卓 / WebView），且只取第一个可用的 */
const uLegacy = [];
screen = { lockOrientation: (v) => { uLegacy.push(v); return true; },
           mozLockOrientation: () => { uLegacy.push('moz'); return true; } };
lockLandscape();
assert('U3 无标准 lock 时退回 screen.lockOrientation（只取第一个可用前缀）',
       uLegacy.length === 1 && uLegacy[0] === 'landscape', JSON.stringify(uLegacy));

/* U4 全屏 API 缺失时（微信 / 老 WebView）仍要尝试锁方向，而不是整个放弃 */
const uSavedFs = document.documentElement.requestFullscreen;
document.documentElement.requestFullscreen = undefined;
const uLock2 = [];
screen = { orientation: { type:'portrait-primary', lock: (v) => { uLock2.push(v); return { catch: () => {} }; } } };
coarsePointer = true;
tryAutoLandscape();
assert('U4 requestFullscreen 缺失时仍然尝试锁方向（只锁方向也强过完全不动）',
       uLock2.length === 1, JSON.stringify(uLock2));
document.documentElement.requestFullscreen = uSavedFs;

/* U5 闸门：只有「触屏 + 竖屏」才挡；横屏与桌面都不打扰 */
const uGate = document.getElementById('rotate-gate');
const uCls = [];
uGate.classList = { toggle:(c,on)=>{ uCls.push(c + '=' + !!on); }, add:NO, remove:NO, contains:()=>false };
rotDismissed = false;
screen = { orientation: { type:'portrait-primary', lock: () => ({ catch: () => {} }) } };
coarsePointer = true;  syncRotateGate();
const uGatePortrait = uCls[uCls.length-1] === 'show=true' && rotGateOn === true;
uCls.length = 0;
screen = { orientation: { type:'landscape-primary', lock: () => ({ catch: () => {} }) } };
syncRotateGate();
const uGateLandscape = uCls[uCls.length-1] === 'show=false';
uCls.length = 0;
screen = { orientation: { type:'portrait-primary', lock: () => ({ catch: () => {} }) } };
coarsePointer = false; syncRotateGate();
const uGateDesk = uCls[uCls.length-1] === 'show=false';
assert('U5 竖屏闸门：触屏 + 竖屏才显示，横屏与桌面都不打扰',
       uGatePortrait && uGateLandscape && uGateDesk, JSON.stringify(uCls));

/* U6 尝试过一次仍未横屏 → 文案改成手动指引；选了「竖屏继续玩」就不再反复弹 */
coarsePointer = true; rotDismissed = false; rotTried = 1;
syncRotateGate();
const uMsgManual = rgDesc.textContent.indexOf('手动') >= 0;
rotDismissed = true; syncRotateGate();
const uDismissed = rotGateOn === false;
assert('U6 选择「竖屏继续玩」后不再弹出；尝试失败后文案改为手动指引',
       uDismissed && uMsgManual, 'manual=' + uMsgManual + ' dismissed=' + uDismissed);

/* U7 第一次触摸/点击就尝试（不局限于「开始游戏」按钮）—— 浏览器只认手势，但不限定元素 */
const uDocH = {};
const uSavedAdd = document.addEventListener;
document.addEventListener = (t, f) => { (uDocH[t] = uDocH[t] || []).push(f); };
armFirstGestureLandscape();
const uArmed = !!(uDocH.pointerdown && uDocH.pointerdown.length) && !!(uDocH.touchstart && uDocH.touchstart.length);
let uFsCalls = 0;
document.documentElement.requestFullscreen = () => { uFsCalls++; return Promise.resolve(); };
coarsePointer = true;  rotFirstDone = false;
uDocH.pointerdown[0]({});
const uFirst = uFsCalls === 1;
uDocH.pointerdown[0]({});                    // 第二次不应再请求
const uOnce = uFsCalls === 1;
coarsePointer = false; rotFirstDone = false;
uDocH.touchstart[0]({});
const uDeskNoop = uFsCalls === 1;
document.addEventListener = uSavedAdd;
document.documentElement.requestFullscreen = uSavedFs;
assert('U7 第一次触摸/点击即尝试全屏横屏（只触发一次，桌面不触发）',
       uArmed && uFirst && uOnce && uDeskNoop, 'armed=' + uArmed + ' fs=' + uFsCalls);

/* U8 竖屏闸门 5 秒倒计时：弹出即开始，文案里带剩余秒数 */
coarsePointer = true; rotDismissed = false; rotTried = 0;
rotAutoDone = false; rotAutoTimer = 0; rotAutoLeft = 0;
syncRotateGate();
const uAutoOn = rotAutoLeft === ROT_AUTO_SEC && rgDesc.textContent.indexOf('5 秒后自动横屏') >= 0;
assert('U8 闸门弹出即开始 5 秒倒计时，并在文案里显示秒数',
       uAutoOn, 'left=' + rotAutoLeft + ' desc=' + rgDesc.textContent);

/* U9 倒计时走完 → 自动执行一次「全屏并横屏」，且不会反复请求 */
const uTriedBefore = rotTried;
for (let i = 0; i < ROT_AUTO_SEC; i++) rotAutoStep();
const uAutoFired = rotTried === uTriedBefore + 1 && rotAutoDone === true && rotAutoLeft === 0;
rotAutoStep();
rotAutoStep();
const uAutoOnce = rotTried === uTriedBefore + 1;
assert('U9 倒计时结束自动横屏一次，之后不再重复触发',
       uAutoFired && uAutoOnce, 'tried=' + uTriedBefore + '->' + rotTried + ' done=' + rotAutoDone);

/* U10 用户主动选「竖屏继续玩」→ 倒计时立即停止，不再自动转 */
rotDismissed = true; syncRotateGate();          // 先让闸门收起，结束这一轮周期
rotDismissed = false; rotAutoTimer = 0; rotAutoLeft = 0;
syncRotateGate();                                // 再次弹出 → 应重新起倒计时
const uRestarted = rotAutoLeft === ROT_AUTO_SEC;
rotDismissed = true; syncRotateGate();
assert('U10 选「竖屏继续玩」后倒计时立刻停止',
       uRestarted && rotAutoLeft === 0 && rotGateOn === false,
       'restart=' + uRestarted + ' left=' + rotAutoLeft + ' gate=' + rotGateOn);

screen = uSavedScreen;
coarsePointer = uSavedCoarse;
rotDismissed = false;
rotTried = 0;
syncRotateGate();

/* ---------- V. 反向换向手感（adadad）----------
 * 反向（左↔右 / 上↔下）必须沿原路平滑退回：交换起终点，绝不 snapToGrid。
 * 修复前每次反向都 snapToGrid，把坦克从格中瞬移回格心 —— 快速 ADAD 时坦克
 * 根本不前进、只在格心附近抽搐。V2 是防回退锁：换向期间 snapToGrid 必须为 0 次。 */
function vArena(){
  netMode = 'off'; player2 = null; paused = false;
  startGame(); levelIntro = 0; freezePlayer = 0;
  enemyQueue.length = 0; enemies.length = 0; bullets.length = 0; items.length = 0;
  for (let r = 4; r < 22; r++) for (let c = 2; c < 24; c++) map[r][c] = EMPTY;
  player.x = 12; player.y = 12;
  player.px = 12*TILE + TILE/2; player.py = 12*TILE + TILE/2;
  player.movingTo = null; player.pendingDir = null; player.dir = 3;
  player.invuln = 999; player.dead = false; player.speed = PLAYER_SPEED;
  for (const k in keys) delete keys[k];
}
function vMaxStep(xs, ys){
  let m = 0;
  for (let i = 1; i < xs.length; i++) m = Math.max(m, Math.abs(xs[i]-xs[i-1]), Math.abs(ys[i]-ys[i-1]));
  return m;
}
/* 速度直接引用 PLAYER_SPEED，单帧位移上限随之自动同步 —— 写死数值会在调速后
 * 把正常位移误判成「瞬移」（v1.6.6 提速时踩过一次）。 */
const V_DT = 1/60, V_STEP = PLAYER_SPEED * TILE * V_DT, V_CAP = V_STEP * 2.05;   // 上限含「到达格心补齐剩余距离」

vArena();
const vx1 = [], vy1 = [];
keys.ArrowLeft = true;
for (let i = 0; i < 6; i++){ updatePlayer(V_DT); vx1.push(player.px); vy1.push(player.py); }
keys.ArrowLeft = false; keys.KeyD = true;
for (let i = 0; i < 10; i++){ updatePlayer(V_DT); vx1.push(player.px); vy1.push(player.py); }
assert('V1 反向（左→右）沿原路平滑退回，无格心瞬移', vMaxStep(vx1, vy1) <= V_CAP && player.px > vx1[5],
       'maxStep=' + vMaxStep(vx1, vy1).toFixed(2) + '/上限' + V_CAP.toFixed(2) + ' px=' + vx1[5].toFixed(1) + '→' + player.px.toFixed(1));

vArena();
let vSnaps = 0;
const vOrigSnap = snapToGrid;
snapToGrid = function(t){ vSnaps++; return vOrigSnap(t); };
const vx2 = [], vy2 = [];
let vTurn = 0;
for (let i = 0; i < 20; i++){
  keys.ArrowLeft = (vTurn === 0); keys.KeyD = (vTurn === 1);
  vTurn ^= 1;
  for (let f = 0; f < 4; f++){ updatePlayer(V_DT); vx2.push(player.px); vy2.push(player.py); }
}
snapToGrid = vOrigSnap;
const vSpan = Math.max.apply(null, vx2) - Math.min.apply(null, vx2);
assert('V2 ADAD×20 换向期间 snapToGrid 零调用（防回退锁）', vSnaps === 0, 'snaps=' + vSnaps);
assert('V3 ADAD×20 全程无瞬移，且确实有往复位移', vMaxStep(vx2, vy2) <= V_CAP && vSpan > 3,
       'maxStep=' + vMaxStep(vx2, vy2).toFixed(2) + ' 极差=' + vSpan.toFixed(2));

/* 修反向不能把「垂直转向」改坏：横↔竖仍必须先对齐格心再换轴，否则斜漂/穿墙 */
vArena();
keys.ArrowLeft = true;
for (let i = 0; i < 5; i++) updatePlayer(V_DT);
keys.ArrowLeft = false; keys.ArrowUp = true;
for (let i = 0; i < 30; i++) updatePlayer(V_DT);
assert('V4 垂直转向（左→上）仍先对格心再换轴，换轴后 x 精确落格心',
       player.dir === 0 && player.py < 12*TILE + TILE/2 &&
       Math.abs(player.px - (Math.round((player.px - TILE/2)/TILE)*TILE + TILE/2)) < 1e-6,
       'dir=' + player.dir + ' px=' + player.px.toFixed(2) + ' py=' + player.py.toFixed(2));

/* 纵向同样成立（上→下）—— 注意只认 ArrowDown / KeyS */
vArena();
const vx3 = [], vy3 = [];
keys.ArrowUp = true;
for (let i = 0; i < 6; i++){ updatePlayer(V_DT); vx3.push(player.px); vy3.push(player.py); }
keys.ArrowUp = false; keys.ArrowDown = true;
for (let i = 0; i < 10; i++){ updatePlayer(V_DT); vx3.push(player.px); vy3.push(player.py); }
assert('V5 纵向反向（上→下）同样无格心瞬移', vMaxStep(vx3, vy3) <= V_CAP,
       'maxStep=' + vMaxStep(vx3, vy3).toFixed(2));

/* 反向时原出发格被别的坦克占住 → 退回旧行为（snap），不崩、不挤进别人格子 */
vArena();
keys.ArrowLeft = true;
for (let i = 0; i < 5; i++) updatePlayer(V_DT);
enemies.push(makeTank(player.x, player.y, 2, 'basic', {}));
let vCrash = null;
try { keys.ArrowLeft = false; keys.KeyD = true; for (let i = 0; i < 20; i++) updatePlayer(V_DT); }
catch(e){ vCrash = e.message; }
assert('V6 原出发格被占时反向不崩溃（安全退回 snap 路径）', !vCrash, vCrash || 'ok');

/* 反向必须「立即转」，不能被「反方向那一格有砖」误判成障碍 ——
 * 长按某方向后突然反向「很钝」，就是这个 pendingDir 造成的（最多等 385ms）。 */
vArena();
map[12][13] = BRICK;                      // 反方向再远一格是砖（旧逻辑会探测到它）
keys.ArrowLeft = true;
for (let i = 0; i < 3; i++) updatePlayer(V_DT);
keys.ArrowLeft = false; keys.KeyD = true;
updatePlayer(V_DT);
assert('V7 反方向那一格有砖时，反向仍立即转向（不被误判为障碍）',
       player.dir === 1 && player.pendingDir === null,
       'dir=' + player.dir + ' pending=' + player.pendingDir);

/* 但垂直转向必须保留探测：上方有砖时不能硬转，要走 pendingDir 缓冲 */
vArena();
map[11][12] = BRICK;
keys.ArrowLeft = true;
for (let i = 0; i < 3; i++) updatePlayer(V_DT);
keys.ArrowLeft = false; keys.ArrowUp = true;
updatePlayer(V_DT);
assert('V8 垂直转向上方有砖时仍走缓冲（不能因为修反向把探测一起短路）',
       player.dir !== 0 && player.pendingDir === 0,
       'dir=' + player.dir + ' pending=' + player.pendingDir);

/* 30Hz 快照 → 60Hz 渲染：1.733px 的快照跳变必须被摊到多帧，不能一次跳满 */
const sm = { px: 251.733, py: 250, rpx: 250, rpy: 250 };
smoothRemoteTank(sm, V_DT);
const smStep1 = sm.rpx - 250;
for (let i = 0; i < 40; i++) smoothRemoteTank(sm, V_DT);
assert('V9 房主坦克渲染插值：快照跳 1.73px 被摊薄到多帧并最终收敛',
       smStep1 > 0.3 && smStep1 < 1.2 && Math.abs(sm.rpx - 251.733) < 0.1,
       '首帧=' + smStep1.toFixed(3) + ' 收敛后=' + sm.rpx.toFixed(3));

/* ---- B 组：v1.6.6 单人容错（B 档） ----
 * 单人「过不去」的两个不公平点：跑不掉（玩家 2.6 vs fast 3.4）与无存档点（一局 25 关）。
 * 命中几何（22x22 判定 + 240px/s 弹速）是原版手感，故意不动，所以这里不测。 */

/* B1 跑不掉已修：快速兵只比玩家快一点点，玩家能拉距离 */
const bFastMul = ETYPES.fast.speed / PLAYER_SPEED;
assert('B1 快速兵相对玩家速度已收敛（≤1.12 倍，原 1.31 倍）',
       bFastMul > 1 && bFastMul <= 1.12,
       'fast=' + ETYPES.fast.speed + ' 玩家=' + PLAYER_SPEED + ' 倍数=' + bFastMul.toFixed(2));

/* B2 预备命数 3 → 合计 4 条命（原 2 → 共 3 条） */
netMode = 'off'; state = 'title'; startDiff = 1;
startGame();
const bLives0 = lives;
assert('B2 新开一局：预备命数 3（合计 4 条命，原共 3 条）',
       bLives0 === START_LIVES && START_LIVES === 3,
       'lives=' + bLives0 + ' START_LIVES=' + START_LIVES);

/* B3 复活无敌 2.5 秒：期间真的免疫伤害（不是只改数字） */
levelIntro = 0; player.dead = false; player.invuln = RESPAWN_INVULN;
const bHit = damageTank(player, 1, 'bullet');
assert('B3 复活无敌 2.5 秒且真的免伤（原 2 秒，防连死雪崩）',
       bHit === false && player.dead === false && RESPAWN_INVULN === 2.5,
       'dmg=' + bHit + ' invuln=' + RESPAWN_INVULN);

/* B4 续关：死在第 N 档 → 重开回到「该档第 1 关」，不再一路退回开局难度 */
state = 'playing'; level = 12;                 // 12 = 精锐档（11~15）第 2 关
gameOver();
const bCp = checkpointLevel;
startGame();                                   // state 此时为 'over' → 走续关分支
assert('B4 死在第 3 档第 2 关后重开 → 从第 11 关（该档第 1 关）开始',
       bCp === 11 && level === 11,
       'checkpoint=' + bCp + ' level=' + level);

/* B5 回标题页重新选难度 → 不续关（玩家明显想从头玩） */
checkpointLevel = 11; startDiff = 2; state = 'title';
startGame();
assert('B5 从标题页重开不续关：回到所选难度第 1 关，续关点清零',
       level === diffStartLevel(2) && checkpointLevel === 0,
       'level=' + level + ' checkpoint=' + checkpointLevel);

/* ---- v1.6.9 「继续本关」与次数上限（字母分组已被占满，这里直接用「续关 N」） ----
 * 与「档位续关」区分：继续本关 = 原地重开同一关、保留分数、消耗次数；
 * 重新开始 = 退回死亡所在难度档的第 1 关、分数清零、不消耗次数。 */
netMode = 'off'; state = 'title'; startDiff = 1;
startGame();
const cSolo = continuesLeft;
netMode = 'host'; state = 'title';
startGame();
const cCoop = continuesLeft;
netMode = 'off';
assert('续关1 配额：单人 5 次 / 双人 8 次',
       cSolo === 5 && cCoop === 8, 'solo=' + cSolo + ' coop=' + cCoop);

state = 'title'; netMode = 'off'; startDiff = 1;
startGame();
level = 7; score = 1234; lives = 0; lives2 = 0; continuesLeft = 3;
state = 'over'; startLockT = 0;
continueLevel();
const cKeep = { lvl: level, score: score, lives: lives, left: continuesLeft, st: state };
assert('续关2 继续本关：关卡不变、分数保留、命数补满、次数 -1',
       cKeep.lvl === 7 && cKeep.score === 1234 && cKeep.lives === START_LIVES &&
       cKeep.left === 2 && cKeep.st === 'playing', JSON.stringify(cKeep));

state = 'over'; continuesLeft = 0; level = 9; startLockT = 0;
continueLevel();
const cEmpty = { lvl: level, st: state, left: continuesLeft };
assert('续关3 次数用完：继续本关不生效（仍停在结束画面）',
       cEmpty.lvl === 9 && cEmpty.st === 'over' && cEmpty.left === 0, JSON.stringify(cEmpty));

state = 'over'; startGame();
assert('续关4 重新开始会把续关次数补满（配额按「一局」算）',
       continuesLeft === CONTINUE_LIMIT_SOLO, 'left=' + continuesLeft);

netMode = 'off'; keys2 = {}; keys = {};
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
