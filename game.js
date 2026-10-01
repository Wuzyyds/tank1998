/* =========================================================
 * 坦克大战 1998 · 增强版 —— 游戏主逻辑
 * 依赖：index.html（结构） / style.css（样式）
 * ========================================================= */
'use strict';
/* ================= 常量 ================= */
const TILE = 20, COLS = 26, ROWS = 26;
const PLAY_W = COLS * TILE, PLAY_H = ROWS * TILE;   // 520 x 520
const PANEL_W = 160;
const W = PLAY_W + PANEL_W, H = PLAY_H;             // 680 x 520
const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, TREE = 4, BASE = 5;
const DESERT = 6, SWAMP = 7, SNOW = 8;              // 地形
const DIRS = [{dx:0,dy:-1},{dx:1,dy:0},{dx:0,dy:1},{dx:-1,dy:0}]; // 上右下左
const SPAWN_POINTS = [{x:0,y:0},{x:12,y:0},{x:24,y:0}];
const PLAYER_SPAWN = {x:8, y:24};
const PLAYER2_SPAWN = {x:16, y:24};   // 双人：玩家2 出生点（(12,24) 是基地，已避开）

/* 道具时效（秒） */
const ITEM_LIFE      = 25;   // 道具停留时间（原 12）
const ITEM_MAX       = 3;    // 同屏道具上限
const ITEM_DROP_RATE = 0.5;  // 普通敌人掉落概率
const KILL_BONUS_EVERY = 3;  // 每 N 杀保底掉落
const AMPHIBIOUS_TIME = 60;  // 水陆两栖 60 秒
const SHIELD_TIME     = 12;
const FREEZE_TIME     = 10;
const EAGLE_TIME      = 60;  // 老鹰：无敌 60 秒（重复拾取重置计时器，不叠加）

/* ---- 敌人侧平衡（避免敌军拾取道具后关卡崩坏） ---- */
const ENEMY_SHIELD_TIME   = 6;    // 敌人吃护盾：6 秒（玩家 12 秒）
const ENEMY_FREEZE_TIME   = 4;    // 敌人吃时钟：冻玩家 4 秒（玩家冻敌 10 秒）
const ENEMY_AMPHIBIOUS_TIME = 20; // 敌人吃两栖：20 秒
const ENEMY_MAX_POWER     = 2;    // 敌人火力封顶 2 级（3 级会蒸干水塘，拆掉地图结构）
const ENEMY_ITEM_GREED    = 0.35; // hunter 型敌人主动抢道具的概率（0 = 只在路过时吃到）

/* ---- 手雷（敌人拾取）：范围爆炸 + 提前警示 ---- */
const GRENADE_FUSE   = 1.0;   // 引信：1 秒，期间画红色警示圈
const GRENADE_RADIUS = 3;     // 爆炸半径（格）

/* ---- 状态效果（燃烧 / 减速 / 过热） ---- */
const BURN_TICK   = 0.4;   // 燃烧每 0.4 秒结算一次
const BURN_TIME   = 2.0;   // 燃烧持续 2 秒（共 5 跳）
const BURN_GEN    = 2;     // 燃烧致死最多传染 2 代
const SLOW_TIME_E = 3.0, SLOW_MUL_E = 0.50, SLOW_FIRE_E = 1.6;  // 对敌：移速 x0.5、射击间隔 x1.6
const SLOW_TIME_P = 2.5, SLOW_MUL_P = 0.60;                     // 对玩家：仅移速 x0.6，不锁射击
const OVERHEAT_TIME = 1.5; // 玩家被点燃：枪管过热 1.5 秒无法射击（不直接致死）
const CLASH_CD    = 0.4;   // 子弹吞噬冷却：一次交火最多被削一级

/* ---- 玩家血量档位（标题页 H 键切换，默认经典一击必死） ---- */
const PLAYER_HP_MODES = [
  { hp: 1, label: '经典' },
  { hp: 2, label: '标准' },
  { hp: 3, label: '宽容' },
];
let hpMode = 0;
function playerMaxHp(){ return PLAYER_HP_MODES[hpMode].hp; }

const ETYPES = {
  basic: { speed:1.6, hp:1, score:100, fire:2.4, body:'#C8CCD2', dark:'#6B7178' },
  fast:  { speed:3.4, hp:1, score:200, fire:2.8, body:'#7FD0FF', dark:'#2E7BB0' },
  power: { speed:2.1, hp:2, score:300, fire:1.3, body:'#FF8A6B', dark:'#B03E20' },
  armor: { speed:1.2, hp:4, score:400, fire:3.2, body:'#F0F0F0', dark:'#A8A8A8' },
  bonus: { speed:2.2, hp:1, score:500, fire:1.8, body:'#FF3B30', dark:'#8E1B14' }, // 红色道具敌人
  boss:  { speed:1.05, hp:10, score:2000, fire:0.9, body:'#B14BFF', dark:'#5B2185' }, // BOSS 关首领
};

/* ================= 难度阶梯（每 5 关一档） =================
 * 旧实现是一条平滑曲线：速度 ×1.6 封顶、每 3 关 +1 血封顶 +2、AI 命中率 0.92 封顶，
 * 于是第 8~10 关之后所有参数都到顶，敌人数也固定 20，再无新挑战。
 * 改为「档位表」：每 5 关整体抬升一档（敌人池 / 速度 / 血量 / AI / 总数），
 *   每档第 4 关 = 精英关（队列前段插入精英，开场即有压迫感）
 *   每档第 5 关 = BOSS 关（末尾追加首领，高血高伤、必掉双道具）
 * 配合关卡主题（见 THEMES），5 个档位对应 5 种地貌。 */
const TIER_SPAN = 5;
const TIERS = [
  { name:'新兵', speed:1.00, hp:0, smart:0.55, total:20, pool:['basic','basic','basic','fast','basic'] },
  { name:'老兵', speed:1.08, hp:0, smart:0.66, total:22, pool:['basic','basic','fast','power','fast'] },
  { name:'精锐', speed:1.16, hp:1, smart:0.76, total:24, pool:['basic','fast','power','armor','fast'] },
  { name:'王牌', speed:1.24, hp:1, smart:0.84, total:26, pool:['fast','power','power','armor','fast'] },
  { name:'噩梦', speed:1.32, hp:2, smart:0.92, total:28, pool:['fast','power','armor','power','armor'] },
];
function tierIndex(){ return Math.min(TIERS.length - 1, Math.floor((level - 1) / TIER_SPAN)); }
function tier(){ return TIERS[tierIndex()]; }
function isBossLevel(){ return level % TIER_SPAN === 0; }
function isEliteLevel(){ return !isBossLevel() && (level % TIER_SPAN) === TIER_SPAN - 1; }
function levelTag(){ return isBossLevel() ? 'BOSS' : (isEliteLevel() ? '精英关' : tier().name); }
const ELITE_TYPES = ['armor', 'power'];
const ELITE_COUNT = 3;
const ITEM_TYPES = ['star','grenade','shield','clock','tank','amphibious','eagle'];
const ITEM_WEIGHT = [26, 12, 18, 14, 10, 20, 8];
const GUN_NAMES = ['普通弹', '穿甲弹', '毁灭弹'];
const GUN_COLORS = ['#FFD23F', '#FF8A00', '#FF3B30'];

/* ================= 武器表 =================
 * 武器叠加在火力等级 power 之上，不替换火力系统：
 *   power 决定弹体尺寸 / 速度 / 穿钢 / 蒸发水 / 同屏弹数
 *   gun   决定命中后的特效（燃烧 / 减速 / 穿透 / 扇形 / 追踪 / 链跳 / 钻砖）
 * ammo 为「射击次数」，散弹一次齐射 3 发只扣 1 次。
 */
const GUNS = {
  normal: { name:'普通弹', color:'#FFE88A', ammo:0,  speedK:1.00, pierce:0, brickPierce:0, burn:0, slow:0, homing:0, chain:0, spread:0 },
  flame:  { name:'火焰枪', color:'#FF6A00', ammo:15, speedK:0.90, pierce:0, brickPierce:0, burn:1, slow:0, homing:0, chain:0, spread:0 },
  frost:  { name:'冷冻枪', color:'#7FD0FF', ammo:12, speedK:1.10, pierce:0, brickPierce:0, burn:0, slow:1, homing:0, chain:0, spread:0 },
  laser:  { name:'激光枪', color:'#B14BFF', ammo:10, speedK:1.60, pierce:3, brickPierce:2, burn:0, slow:0, homing:0, chain:0, spread:0 },
  spread: { name:'散弹枪', color:'#FFD23F', ammo:12, speedK:1.00, pierce:0, brickPierce:0, burn:0, slow:0, homing:0, chain:0, spread:3 },
  homing: { name:'追踪弹', color:'#46B455', ammo:8,  speedK:0.85, pierce:0, brickPierce:0, burn:0, slow:0, homing:1, chain:0, spread:0 },
  tesla:  { name:'电磁链', color:'#4FD1E0', ammo:10, speedK:1.00, pierce:0, brickPierce:0, burn:0, slow:0, homing:0, chain:3, spread:0 },
  drill:  { name:'穿甲钻', color:'#C7CDD4', ammo:10, speedK:1.15, pierce:3, brickPierce:4, burn:0, slow:0, homing:0, chain:0, spread:0 },
};
const WEAPON_TYPES  = ['flame','frost','laser','spread','homing','tesla','drill'];
const WEAPON_WEIGHT = [22, 20, 14, 16, 10, 10, 8];   // 总 100
const WEAPON_RING = { flame:'#FF6A00', frost:'#7FD0FF', laser:'#B14BFF',
                      spread:'#FFD23F', homing:'#46B455', tesla:'#4FD1E0', drill:'#C7CDD4' };
/* 武器道具的字母标识：地图上的武器格子直接显示字母，比矢量小图标更快辨认
 * F火焰枪 C冷冻枪 L激光枪 S散弹枪 H追踪弹 T电磁链 D穿甲钻 */
const WEAPON_LETTER = { flame:'F', frost:'C', laser:'L', spread:'S', homing:'H', tesla:'T', drill:'D' };
const CLASSIC_POOL_RATE = 0.5;   // 经典道具池占比（武器占 50%，保证玩家能频繁见到武器）
const WEAPON_UNLOCK_LEVEL = 1;   // 所有关卡均可能掉落武器（不再限制第 2 关起）
const ENEMY_NO_GUN = { homing: 1 };  // 追踪 + 一击必死过于劝退，敌军无法使用

function gunDef(t){ return GUNS[(t && t.gun) || 'normal'] || GUNS.normal; }

const rnd  = (a, b) => a + Math.random() * (b - a);
const rndi = (a, b) => Math.floor(rnd(a, b + 1));
const pick = arr => arr[(Math.random() * arr.length) | 0];

/* ================= 画布 ================= */
const canvas = document.getElementById('game');
let ctx = canvas.getContext('2d');   // 绘制地形缓存时需临时切到离屏上下文，故用 let

/* ================= 地形离屏缓存 + 脏区重绘 =================
 * 砖 / 钢 / 沙 / 沼 / 雪 / 基地 在一关内基本不变，原先却每帧重画 676 个格子。
 * 改为预渲染到离屏画布，只在格子真正变化（打穿砖墙、蒸发水面、基地被毁）时重画那一小块，
 * 移动端每帧的 fillRect 数量下降一个数量级。
 * 水（波纹动画）与树（必须盖住坦克）不进缓存，仍每帧绘制。 */
let terrainCanvas = null, terrainCtx = null;
let terrainFull = true;                  // 需要整张重建
let terrainDirty = Object.create(null);  // 脏格集合："r,c" -> true
let terrainDirtyCount = 0;
/* 网络地图增量（详见「双人合作：网络同步」）：与本文件的脏区机制同源，
 * 声明放在最前面，避免 setTile 在初始化阶段被调用时踩到 TDZ。 */
let tileDelta = [];
let snapFullNeeded = true;

function isTerrainCacheable(v){
  // 基地老鹰占 2x2 格，若进缓存会被脏区 clearRect 局部重绘切掉边角，
  // 故 BASE 不进缓存，由 render() 在最后单独整只绘制。
  return v === BRICK || v === STEEL || v === DESERT || v === SWAMP || v === SNOW;
}
function initTerrain(){
  if (!terrainCanvas){
    terrainCanvas = document.createElement('canvas');
    terrainCtx = terrainCanvas.getContext('2d');
  }
  terrainCanvas.width  = PLAY_W * DPR;
  terrainCanvas.height = PLAY_H * DPR;
  terrainFull = true;
  terrainDirty = Object.create(null);
  terrainDirtyCount = 0;
}
function markTileDirty(r, c){
  if (r < 0 || c < 0 || r >= ROWS || c >= COLS) return;
  const k = r + ',' + c;
  if (!terrainDirty[k]){ terrainDirty[k] = true; terrainDirtyCount++; }
  if (terrainDirtyCount > 200) terrainFull = true;   // 大面积变化直接整张重建
}
/* 地形改写统一入口：改 map 的同时标记脏格，避免缓存与 map 不一致 */
function setTile(r, c, v){
  if (map[r] && map[r][c] === v) return;
  map[r][c] = v;
  markTileDirty(r, c);
  tileDelta.push([r, c, v]);                       // 顺带记入网络增量（单人模式下到点被丢弃）
  if (tileDelta.length > 200) snapFullNeeded = true;   // 大面积破坏 → 下一帧退回全量地图
}
/* 把一格地形画进当前 ctx（刷新缓存时 ctx 已切到离屏） */
function paintTerrainCell(r, c){
  const v = map[r][c], x = c*TILE, y = r*TILE;
  if (v === BRICK) drawBrick(x, y);
  else if (v === STEEL) drawSteel(x, y);
  else if (v === DESERT) drawDesert(x, y);
  else if (v === SWAMP) drawSwamp(x, y);
  else if (v === SNOW) drawSnow(x, y);
}
function flushTerrain(){
  if (!terrainCtx) return;
  if (!terrainFull && !terrainDirtyCount) return;   // 无变化：本帧零成本
  const swap = ctx; ctx = terrainCtx;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (terrainFull){
    ctx.clearRect(0, 0, PLAY_W, PLAY_H);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++){
      if (isTerrainCacheable(map[r][c])) paintTerrainCell(r, c);
    }
    terrainFull = false;
  } else {
    const keys = [];
    for (const k in terrainDirty) keys.push(k);
    for (const key of keys){
      const p = key.split(','), r = +p[0], c = +p[1];
      // 外扩一圈：老鹰占 2x2、相邻格描边可能压到本格
      ctx.clearRect((c-1)*TILE, (r-1)*TILE, TILE*3, TILE*3);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++){
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= ROWS || cc >= COLS) continue;
        if (isTerrainCacheable(map[rr][cc])) paintTerrainCell(rr, cc);
      }
    }
  }
  terrainDirty = Object.create(null);
  terrainDirtyCount = 0;
  ctx = swap;
}

/* ================= 图块精灵：把「逐格重绘」变为「每格一次 drawImage」 =================
 * 水 / 树 / 老鹰基地原先每帧按格重画，成本随格子数线性增长：
 *   - 老鹰基地：20x20 像素图 → 每帧最多 400 次 fillRect + 400 次 fillStyle
 *   - 树：每格 2 次 fillRect + 4 次 arc
 *   - 水：每格 4 次 fillRect
 * 但它们只与「格子外观 / 波纹相位」有关、与所在位置无关，
 * 因此预渲染成 24x24（老鹰 40x40）的小精灵，运行时每格只提交一次 drawImage。
 * 绘制代码原地复用（仅把 ctx 临时切到离屏画布），视觉与原实现逐像素一致。 */
let tileSprites = null;      // { tree, water:[相位0, 相位1] }
let eagleSprite = null;      // 40x40：金色底座 + 像素老鹰（基地）
let eagleItemSprite = null;  // 20x20：老鹰道具图标
let bulletSprites = null;    // { 'gun:power' -> 16x20 弹体精灵 }
function makeSprite(w, h, paint){
  const cv = document.createElement('canvas');
  cv.width  = Math.max(1, Math.round(w * DPR));
  cv.height = Math.max(1, Math.round(h * DPR));
  const c2 = (typeof cv.getContext === 'function') ? cv.getContext('2d') : null;
  if (!c2) return null;
  const swap = ctx;
  ctx = c2;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  paint();
  ctx = swap;
  return cv;
}
function initTileSprites(){
  if (tileSprites) return;
  tileSprites = {
    tree:  makeSprite(TILE, TILE, () => paintTree(0, 0)),
    water: [ makeSprite(TILE, TILE, () => paintWater(true,  0, 0)),   // 相位 0：波纹在上
             makeSprite(TILE, TILE, () => paintWater(false, 0, 0)) ], // 相位 1：波纹在下
  };
}
function initEagleSprite(){
  if (eagleSprite) return;
  eagleSprite = makeSprite(40, 40, () => {
    px(0, 0, 40, 40, '#8A5A00');   // 金色底座
    px(2, 2, 36, 36, '#FFC300');
    px(4, 4, 32, 32, '#FFDB4D');
    px(4, 4, 32, 2, '#FFEEA0');
    paintEagleArt(0, 0, 2);        // 20x20 像素老鹰（放大 2 倍）
  });
}

/* 触屏设备识别：命中时 canvas 只保留游戏区（面板由 CSS 裁掉），
 * 分数/命数/关卡等信息改由 DOM HUD（#hud）以正常字号呈现，解决小屏不可读问题。
 * 桌面端 coarsePointer=false，canvas 内面板绘制路径完全不变。
 * 注：必须在 setupHiDPI 之前确定，DPR 上限依赖它。 */
let coarsePointer = false;
function syncCoarsePointer(){
  try { coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches; }
  catch (e) { coarsePointer = false; }
}

/* 高分屏适配：按 devicePixelRatio 放大画布背板，绘制时缩放坐标系，
 * 逻辑坐标仍是 680x520（所有绘制代码无需改动），手机高分屏不再发虚。
 * 上限策略：桌面 3x；触屏 2x —— 手机上 DPR 3 会把背板撑到约 2000x1560
 * （每帧 320 万像素的填充率），而像素风在 2x 下已看不出差别，故触屏封顶 2x。 */
const DPR_MAX_DESKTOP = 3, DPR_MAX_TOUCH = 2;
let DPR = 1;
function setupHiDPI(){
  const raw = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const dpr = Math.min(coarsePointer ? DPR_MAX_TOUCH : DPR_MAX_DESKTOP, raw);
  DPR = dpr;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  initTerrain();                        // DPR 变化后地形缓存需按新分辨率重建
  tileSprites = null; eagleSprite = null; eagleItemSprite = null;   // 精灵同理：按新 DPR 重新烘焙
  bulletSprites = null;
}
syncCoarsePointer();
setupHiDPI();
if (typeof window !== 'undefined' && window.addEventListener){
  window.addEventListener('resize', setupHiDPI);
  try {
    const mq = typeof matchMedia === 'function' ? matchMedia('(pointer:coarse)') : null;
    if (mq && mq.addEventListener) mq.addEventListener('change', () => { syncCoarsePointer(); setupHiDPI(); });
  } catch (e) { /* 老浏览器忽略 */ }
}

/* ================= 资源清单（图片 / 音效，全部带回退） =================
 * 坦克图 28x36：炮管朝上（dir=0），内容居中，带透明通道 → 中心对齐 + 旋转绘制
 * 道具图 48x48：主题色底 + 黑色图标区 → 缩放铺满一个格子 (20x20)
 * eagle 道具暂无素材图，沿用代码绘制的老鹰像素图标
 */
const TANK_IMG_SRC = {
  player: 'assets/images/tanks/tank_player.png',
  basic:  'assets/images/tanks/tank_basic.png',
  fast:   'assets/images/tanks/tank_fast.png',
  power:  'assets/images/tanks/tank_power.png',
  armor:  'assets/images/tanks/tank_armor.png',
  bonus:  'assets/images/tanks/tank_bonus.png',
};
const ITEM_IMG_SRC = {
  star:       'assets/images/items/item_star.png',
  grenade:    'assets/images/items/item_grenade.png',
  shield:     'assets/images/items/item_shield.png',
  clock:      'assets/images/items/item_clock.png',
  tank:       'assets/images/items/item_tank.png',
  amphibious: 'assets/images/items/item_amphibious.png',
};
const SND_SRC = {
  shoot:      'assets/audio/shoot.wav',
  brick:      'assets/audio/brick.wav',
  steel:      'assets/audio/steel.wav',
  spark:      'assets/audio/spark.wav',
  boom:       'assets/audio/boom.wav',
  playerBoom: 'assets/audio/player_boom.wav',
  spawn:      'assets/audio/spawn.wav',
  item:       'assets/audio/item.wav',
  itemPickup: 'assets/audio/item_pickup.wav',
  shield:     'assets/audio/shield.wav',
  clock:      'assets/audio/clock.wav',
  clear:      'assets/audio/clear.wav',
  over:       'assets/audio/over.wav',
};
const SND_VOL = 0.55;   // 素材峰值已标准化到 0.95，统一衰减防爆音

/* 图片：加载失败自动回退矢量绘制 */
const IMG = {};   // key -> { ok, el, flashEl }
function loadImage(key, src){
  const rec = { ok: false, el: null, flashEl: null };
  IMG[key] = rec;
  try {
    const im = new Image();
    im.onload = () => {
      rec.ok = true;
      rec.el = im;
      /* 白闪版本：source-atop 叠白，供 bonus 闪烁与全坦克受击反馈复用 */
      if (key.indexOf('tank_') === 0){
        try {
          const cv = document.createElement('canvas');
          cv.width = im.width || 28;
          cv.height = im.height || 36;
          const g = cv.getContext('2d');
          g.drawImage(im, 0, 0);
          g.globalCompositeOperation = 'source-atop';
          g.fillStyle = 'rgba(255,255,255,0.72)';
          g.fillRect(0, 0, cv.width, cv.height);
          rec.flashEl = cv;
        } catch(e) { rec.flashEl = null; }
      }
    };
    im.onerror = () => { rec.ok = false; };
    im.src = src;
  } catch(e) { rec.ok = false; }
}
for (const k in TANK_IMG_SRC) loadImage('tank_' + k, TANK_IMG_SRC[k]);
for (const k in ITEM_IMG_SRC) loadImage('item_' + k, ITEM_IMG_SRC[k]);

/* 音效三级回退：WebAudio 缓冲(可叠加/低延迟) → <audio> 元素(file:// 可用) → 合成 beep */
const SND = {};       // key -> AudioBuffer
const SND_EL = {};    // key -> HTMLAudioElement
let sndFetchTried = false;
function initAudioAssets(){
  if (sndFetchTried || !actx) return;
  sndFetchTried = true;
  for (const key in SND_SRC){
    const _fetch = (typeof fetch === 'function') ? fetch : null;
    const load = _fetch ? _fetch(SND_SRC[key]) : Promise.reject(new Error('no fetch'));
    load.then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then(ab => new Promise((res, rej) => {
        try { actx.decodeAudioData(ab, res, rej); } catch(e) { rej(e); }
      }))
      .then(buf => { SND[key] = buf; })
      /* 文件取不到（服务器不提供 .wav / file:// / 404）→ 用内嵌 dataURI 解码 */
      .catch(() => decodeDataUri(key).then(buf => { SND[key] = buf; }).catch(() => { SND[key] = null; }));
  }
}
/* 把内嵌的 base64 dataURI 解成 AudioBuffer */
function decodeDataUri(key){
  return new Promise((res, rej) => {
    const d = window.TANK_SND && window.TANK_SND[key];
    if (!d || !actx || typeof atob !== 'function') return rej(new Error('no data uri'));
    try {
      const bin = atob(d.slice(d.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      actx.decodeAudioData(bytes.buffer, res, rej);
    } catch(e) { rej(e); }
  });
}
function playSnd(key){
  if (muted) return false;
  if (actx && actx.state === 'suspended'){ try { actx.resume(); } catch(e) {} }
  const buf = SND[key];
  if (buf && actx){
    try {
      const src = actx.createBufferSource();
      src.buffer = buf;
      const g = actx.createGain();
      g.gain.value = SND_VOL;
      src.connect(g); g.connect(sfxOut());
      src.start();
      return true;
    } catch(e) {}
  }
  if (actx) return false;   // 有 AudioContext 就交给 beep 合成兜底（比 <audio> 更可靠）
  /* 无 AudioContext：退到 <audio> 元素，优先用内嵌 dataURI（部分静态服务器不提供 .wav） */
  let el = SND_EL[key];
  if (el === false) return false;
  if (!el){
    const uri = (window.TANK_SND && window.TANK_SND[key]) || SND_SRC[key];
    try { el = new Audio(uri); el.volume = SND_VOL; SND_EL[key] = el; }
    catch(e) { SND_EL[key] = false; return false; }
  }
  try {
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => { SND_EL[key] = false; });   // 播放被拒 → 下次交给 beep
    return true;
  } catch(e) { SND_EL[key] = false; return false; }
}
/* 音频是否真的能出声（用于 UI 提示） */
function audioBlocked(){ return !actx || actx.state === 'suspended'; }

/* ================= 随机地图生成 ================= */
function blankMap(){
  return Array.from({length: ROWS}, () => Array(COLS).fill(EMPTY));
}
function fillRect(m, r1, c1, r2, c2, t){
  for (let r = Math.max(0, r1); r <= Math.min(ROWS-1, r2); r++)
    for (let c = Math.max(0, c1); c <= Math.min(COLS-1, c2); c++)
      m[r][c] = t;
}
function clearRect(m, r1, c1, r2, c2){
  fillRect(m, r1, c1, r2, c2, EMPTY);
}

/* ---- 关卡主题：决定地貌配比，5 个档位对应 5 种地图观感/战术 ----
 * 草原（均衡）· 沙漠（开阔少掩体）· 雪原（减速）· 沼泽（泥泞 + 多水）· 钢铁（钢墙密集） */
const THEMES = [
  { name:'草原', terrain:[DESERT, SWAMP, SNOW], terr:[3,5], brick:[16,22], steel:[3,5], water:[2,3], tree:[4,6] },
  { name:'沙漠', terrain:[DESERT],              terr:[4,6], brick:[14,20], steel:[3,5], water:[1,2], tree:[2,3] },
  { name:'雪原', terrain:[SNOW],                terr:[4,6], brick:[16,22], steel:[3,5], water:[2,4], tree:[3,5] },
  { name:'沼泽', terrain:[SWAMP],               terr:[4,7], brick:[16,22], steel:[2,4], water:[4,6], tree:[4,6] },
  { name:'钢铁', terrain:[DESERT, SNOW],        terr:[3,5], brick:[18,24], steel:[6,9], water:[2,3], tree:[3,5] },
];
function themeForLevel(lv){ return THEMES[(Math.floor((lv - 1) / TIER_SPAN)) % THEMES.length]; }

/* 生成一次随机地图（不做校验） */
function randomMapAttempt(theme){
  const T = theme || THEMES[0];
  const m = blankMap();

  /* 1. 地形块：由主题决定地貌类型与数量 */
  const terrCount = rndi(T.terr[0], T.terr[1]);
  for (let i = 0; i < terrCount; i++){
    const t = pick(T.terrain);
    const h = rndi(2, 4), w = rndi(4, 9);
    const r = rndi(1, ROWS - 2 - h), c = rndi(0, COLS - 1 - w);
    fillRect(m, r, c, r + h - 1, c + w - 1, t);
  }

  /* 2. 砖墙簇 */
  const brickClusters = rndi(T.brick[0], T.brick[1]);
  for (let i = 0; i < brickClusters; i++){
    const shape = pick(['h','v','box','dot']);
    const r = rndi(2, ROWS - 3), c = rndi(0, COLS - 1);
    if (shape === 'h')   fillRect(m, r, c, r, c + rndi(3, 7), BRICK);
    else if (shape === 'v') fillRect(m, r, c, r + rndi(2, 5), c, BRICK);
    else if (shape === 'box') fillRect(m, r, c, r + rndi(1, 2), c + rndi(2, 4), BRICK);
    else fillRect(m, r, c, r, c, BRICK);
  }

  /* 3. 钢墙簇（少量，避免封死） */
  const steelClusters = rndi(T.steel[0], T.steel[1]);
  for (let i = 0; i < steelClusters; i++){
    const r = rndi(3, ROWS - 4), c = rndi(1, COLS - 3);
    fillRect(m, r, c, r + rndi(0, 1), c + rndi(1, 3), STEEL);
  }

  /* 4. 水塘 */
  const ponds = rndi(T.water[0], T.water[1]);
  for (let i = 0; i < ponds; i++){
    const r = rndi(3, ROWS - 6), c = rndi(1, COLS - 6);
    fillRect(m, r, c, r + rndi(0, 1), c + rndi(2, 5), WATER);
  }

  /* 5. 树林 */
  const groves = rndi(T.tree[0], T.tree[1]);
  for (let i = 0; i < groves; i++){
    const r = rndi(2, ROWS - 3), c = rndi(0, COLS - 4);
    fillRect(m, r, c, r + rndi(0, 2), c + rndi(1, 4), TREE);
  }

  /* 6. 基地 + 保护墙（固定，保证原版手感） */
  m[24][12] = BASE; m[24][13] = BASE;
  m[25][12] = BASE; m[25][13] = BASE;
  fillRect(m, 22, 10, 23, 15, BRICK);
  fillRect(m, 24, 10, 25, 11, BRICK);
  fillRect(m, 24, 14, 25, 15, BRICK);

  /* 7. 清出生点 / 玩家出生区，保证不卡死 */
  for (const p of SPAWN_POINTS) clearRect(m, p.y, p.x, p.y + 1, p.x + 1);
  clearRect(m, 0, 0, 1, 25);                 // 顶部出生走廊
  clearRect(m, 23, 7, 25, 10);               // 玩家出生区
  clearRect(m, 23, 15, 25, 17);             // 玩家2 出生区
  clearRect(m, 22, 11, 22, 14);              // 基地保护墙上方入口
  return m;
}

/* BFS 连通性：砖可打穿视为通行，钢/水视为障碍 */
function reachable(m, sy, sx){
  const seen = Array.from({length: ROWS}, () => Array(COLS).fill(false));
  const q = [[sy, sx]]; seen[sy][sx] = true;
  let head = 0;
  while (head < q.length){
    const [y, x] = q[head++];
    for (const d of DIRS){
      const ny = y + d.dy, nx = x + d.dx;
      if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS) continue;
      if (seen[ny][nx]) continue;
      const v = m[ny][nx];
      if (v === STEEL || v === WATER) continue;
      seen[ny][nx] = true;
      q.push([ny, nx]);
    }
  }
  return seen;
}
/* 地图是否可玩：至少一个出生点能同时够到玩家出生区和基地上方 */
function isMapPlayable(m){
  let ok = false;
  for (const p of SPAWN_POINTS){
    const seen = reachable(m, p.y, p.x);
    if (seen[PLAYER_SPAWN.y][PLAYER_SPAWN.x] && (seen[22][12] || seen[23][12] || seen[21][12])) { ok = true; break; }
  }
  return ok;
}
let levelThemeName = '';
function buildMap(){
  const theme = themeForLevel(level);
  levelThemeName = theme.name;
  for (let i = 0; i < 60; i++){
    const m = randomMapAttempt(theme);
    if (isMapPlayable(m)) return m;
  }
  // 保底：极简可用布局
  const m = blankMap();
  fillRect(m, 22, 10, 23, 15, BRICK);
  m[24][12] = BASE; m[24][13] = BASE; m[25][12] = BASE; m[25][13] = BASE;
  return m;
}

let map = [];
function isWalkableGround(v){ return v === EMPTY || v === DESERT || v === SWAMP || v === SNOW; }
function tileSpeedMul(t){
  const v = map[t.y] && map[t.y][t.x];
  if (v === SWAMP) return 0.45;
  if (v === SNOW)  return 0.7;
  return 1;
}

/* ================= 音频 ================= */
let actx = null;

/* ---- 音量总线：源 → 音效/音乐总线 → 主总线 → destination ----
 * 原先每个音源都直连 destination，只能整体静音、且设置不持久化。
 * 现在三级可分别调节并写入 localStorage。 */
/* 存的是「滑杆位置 0~1」，实际增益经 volCurve() 近似等响度后使用。
 * 默认值按曲线反推，保证初始响度与旧版接近（0.9²≈0.81 对应旧 0.8）。 */
const VOL = { master: 0.9, sfx: 0.95, music: 0.65 };
let masterGain = null, sfxGain = null, musicGain = null, limiter = null;
try {
  const sv = JSON.parse(localStorage.getItem('tank1998_vol') || '{}');
  for (const k in VOL) if (typeof sv[k] === 'number') VOL[k] = Math.max(0, Math.min(1, sv[k]));
} catch(e) {}
function saveVolumes(){ try { localStorage.setItem('tank1998_vol', JSON.stringify(VOL)); } catch(e) {} }
function audioBusInit(){
  if (!actx || masterGain) return;
  try {
    masterGain = actx.createGain();
    sfxGain    = actx.createGain();
    musicGain  = actx.createGain();
    sfxGain.connect(masterGain);
    musicGain.connect(masterGain);
    /* 总线上挂一个限幅器：后期敌我数十门炮同时开火、爆炸、吃道具与 BGM 叠加时，
     * 各音源线性相加会超过 0dBFS → 硬削波，听感是"噼啪"爆音。
     * -8dB 以上按 12:1 压制，既压住峰值又几乎听不出动态损失。 */
    try {
      limiter = actx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      masterGain.connect(limiter);
      limiter.connect(actx.destination);
    } catch(e) {
      limiter = null;                          // 极简实现（无压缩器）时直连，不影响出声
      masterGain.connect(actx.destination);
    }
    applyVolumes();
  } catch(e) { masterGain = sfxGain = musicGain = null; }
}
/* 滑杆是线性 0~1，但人耳对响度的感知接近对数：
 * 直接把滑杆值当增益用，会出现「下半程几乎听不出变化、上半程骤降」。
 * 平方曲线近似等响度，滑杆手感才接近线性。（0.5²=0.25 ≈ -12dB，接近"一半响度"） */
function volCurve(v){ const x = Math.max(0, Math.min(1, v)); return x * x; }
function applyVolumes(){
  if (masterGain) masterGain.gain.value = muted ? 0 : volCurve(VOL.master);
  if (sfxGain)    sfxGain.gain.value    = volCurve(VOL.sfx);
  if (musicGain)  musicGain.gain.value  = volCurve(VOL.music);
}
function sfxOut(){ return sfxGain || (actx && actx.destination); }

/* ---- 背景音乐：程序化 chiptune（无外部素材，随游戏状态切换） ----
 * 以八分音符为一格；'.' 为延音、'-' 为休止。用「提前排程」而不是到点才发声，节奏更稳。 */
const NOTE = { A2:110.00, C3:130.81, D3:146.83, E3:164.81, F3:174.61, G3:196.00, A3:220.00, B3:246.94,
               C4:261.63, D4:293.66, E4:329.63, F4:349.23, G4:392.00, A4:440.00, B4:493.88,
               C5:523.25, D5:587.33, E5:659.25, G5:783.99, A5:880.00 };
const BGM = {
  title: { bpm: 92,
    lead: 'A4 . . . G4 . E4 . D4 . . . E4 . . . A4 . . . G4 . E4 . C4 . D4 . . . . . . .',
    bass: 'A2 . . . . . . . E3 . . . . . . . F3 . . . . . . . G3 . . . . . . .' },
  battle: { bpm: 138,
    lead: 'A4 . C5 . E5 . C5 . D5 . . . C5 . A4 . G4 . A4 . C5 . A4 . E4 . . . . . . .',
    bass: 'A2 . A2 . E3 . E3 . F3 . F3 . G3 . G3 . A2 . A2 . E3 . E3 . F3 . G3 .' },
};
let bgmOn = true;
try { bgmOn = localStorage.getItem('tank1998_bgm') !== '0'; } catch(e) {}
let bgmName = null, bgmStep = 0, bgmNextT = 0, bgmTimer = null;
function playNote(name, t, dur, type, vol){
  const f = NOTE[name];
  if (!f || !actx) return;
  try {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(musicGain || actx.destination);
    o.start(t); o.stop(t + dur + 0.03);
  } catch(e) {}
}
/* 每 120ms 向前排 0.45 秒的谱，避免用 setTimeout 直接发声导致节奏抖动 */
function bgmSchedule(){
  if (!actx || !bgmName) return;
  const tr = BGM[bgmName];
  const step = 60 / tr.bpm / 2;
  const lead = tr.lead.split(' '), bass = tr.bass.split(' ');
  /* 卡顿保护：主线程一旦停顿（GC / 长帧 / 后台节流），bgmNextT 会落后于
   * actx.currentTime，补排循环就把一串音符全塞进"过去的时间点"——
   * Web Audio 会立即齐发，变成一声噪音爆音。
   * 落后超过半拍就对齐到当前时间：宁可少几个音，也不要爆音。 */
  if (bgmNextT < actx.currentTime - step * 0.5) bgmNextT = actx.currentTime + 0.03;
  let guard = 0;
  while (bgmNextT < actx.currentTime + 0.45 && guard++ < 64){
    const li = bgmStep % lead.length, bi = bgmStep % bass.length;
    playNote(lead[li], bgmNextT, step * 0.88, 'square',   0.13);
    playNote(bass[bi], bgmNextT, step * 0.94, 'triangle', 0.20);
    bgmNextT += step;
    bgmStep++;
  }
}
function bgmStart(name){
  if (!actx || !BGM[name]) return;
  bgmName = name; bgmStep = 0;
  bgmNextT = actx.currentTime + 0.06;
  if (!bgmTimer) bgmTimer = setInterval(bgmSchedule, 120);
  bgmSchedule();
}
function bgmStop(){
  bgmName = null;
  if (bgmTimer){ clearInterval(bgmTimer); bgmTimer = null; }
}
/* 主循环每帧调用：按游戏状态切换曲目（无 AudioContext / 关掉音乐时为空操作） */
function syncBgm(){
  if (!actx || !bgmOn || paused || state === 'over'){ if (bgmName) bgmStop(); return; }
  const want = state === 'title' ? 'title' : 'battle';
  if (want !== bgmName) bgmStart(want);
}
function setBgmOn(on){
  bgmOn = !!on;
  try { localStorage.setItem('tank1998_bgm', bgmOn ? '1' : '0'); } catch(e) {}
  if (!bgmOn) bgmStop();
}
function setVolume(bus, v){
  if (!(bus in VOL)) return;
  VOL[bus] = Math.max(0, Math.min(1, v));
  saveVolumes();
  applyVolumes();
}

function initAudio(){
  if (!actx){
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
    initAudioAssets();   // AudioContext 就绪后预取 wav 素材
    audioBusInit();      // 建好音量总线（之后所有音源都接到总线上）
    /* iOS/Chrome 自动播放策略：手势内播一个静音 buffer 解锁输出 */
    if (actx){
      try {
        const b = actx.createBuffer(1, 1, 22050);
        const s = actx.createBufferSource();
        s.buffer = b; s.connect(actx.destination); s.start(0);
      } catch(e) {}
    }
  }
  /* 每次交互都尝试恢复被浏览器挂起的上下文 */
  if (actx && actx.state === 'suspended'){ try { actx.resume(); } catch(e) {} }
  syncBgm();
}
function beep(freq, dur, type, vol, slideTo){
  if (!actx || muted) return;
  try {
    const o = actx.createOscillator(), g = actx.createGain();
    const t = actx.currentTime;
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
    g.gain.setValueAtTime(vol || 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(sfxOut());
    o.start(t); o.stop(t + dur + 0.02);
  } catch(e) {}
}
let noiseBuf = null;
function noise(dur, vol){
  if (!actx || muted) return;
  try {
    if (!noiseBuf) {
      noiseBuf = actx.createBuffer(1, actx.sampleRate * 1, actx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = actx.createBufferSource(); src.buffer = noiseBuf;
    const g = actx.createGain(); const t = actx.currentTime;
    g.gain.setValueAtTime(vol || 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(g); g.connect(sfxOut());
    src.start(t); src.stop(t + dur);
  } catch(e) {}
}
const sfxRaw = {
  shoot()    { if (playSnd('shoot')) return; beep(620, 0.08, 'square', 0.10, 180); },
  brick()    { if (playSnd('brick')) return; beep(280, 0.06, 'square', 0.12, 120); },
  steel()    { if (playSnd('steel')) return; beep(950, 0.05, 'square', 0.09); },
  spark()    { if (playSnd('spark')) return; beep(1400, 0.03, 'square', 0.06); },
  boom()     { if (playSnd('boom')) return; noise(0.4, 0.30); beep(110, 0.35, 'sawtooth', 0.18, 45); },
  playerBoom(){ if (playSnd('playerBoom')) return; noise(0.6, 0.38); beep(160, 0.5, 'sawtooth', 0.22, 40); },
  spawn()    { if (playSnd('spawn')) return; beep(320, 0.18, 'square', 0.10, 640); },
  item()     { if (playSnd('item')) return; beep(523, 0.09, 'square', 0.12); setTimeout(() => beep(784, 0.12, 'square', 0.12), 90); },
  itemPickup(){ if (playSnd('itemPickup')) return; sfx.item(); },
  shield()   { if (playSnd('shield')) return; beep(400, 0.12, 'triangle', 0.15, 800); },
  clock()    { if (playSnd('clock')) return; beep(900, 0.10, 'square', 0.10, 200); beep(300, 0.15, 'square', 0.10, 600); },
  clear()    { if (playSnd('clear')) return; [523,659,784,1047].forEach((f,i) => setTimeout(() => beep(f, 0.14, 'square', 0.14), i*110)); },
  over()     { if (playSnd('over')) return; [392,330,262,196].forEach((f,i) => setTimeout(() => beep(f, 0.22, 'sawtooth', 0.14), i*170)); },
};
/* 同名音效节流：后期双方几十门炮同时开火，逐发发声会糊成一片，
 * 并在一瞬间创建几十个音频节点。高频音效设最小间隔后听感更清晰。
 * 间隔远小于任何坦克的射速（fire 量级 0.2s+），正常操作不会漏音。 */
const SFX_MIN_GAP = { shoot: 0.03, brick: 0.02, steel: 0.02, spark: 0.03 };
const sfxLastAt = Object.create(null);
function sfxThrottled(name){
  const gap = SFX_MIN_GAP[name];
  if (!gap) return false;
  const now = actx ? actx.currentTime : gameTime;
  const last = sfxLastAt[name];
  if (last !== undefined && now - last < gap) return true;
  sfxLastAt[name] = now;
  return false;
}
const sfx = {};
for (const k in sfxRaw){
  sfx[k] = (key => () => { if (!sfxThrottled(key)) sfxRaw[key](); })(k);
}

/* ================= 游戏状态 ================= */
let state = 'title';        // title | playing | clear | over
let level = 1, score = 0, hiScore = 0, lives = 2;
let nextExtraLifeScore = 2000;   // 每 2000 分奖一命
let player = null, enemies = [], bullets = [], items = [], explosions = [];
let enemyQueue = [], spawnTimer = 0, killCount = 0;
let freezeEnemies = 0, freezePlayer = 0, baseAlive = true, overReason = '';
let playerEagle = 0;        // 老鹰无敌剩余时间（秒）
let levelIntro = 0;         // FC 经典幕布开场剩余时间（秒）
const LEVEL_INTRO_TIME = 1.6;
let startLockT = 0;         // 结束/过关后的误触保护：此时间点前忽略“开始”请求
let paused = false, muted = false, gameTime = 0;
try { muted = localStorage.getItem('tank1998_muted') === '1'; } catch(e) {}   // 静音设置持久化
let keys = {};
/* ---- 双人合作状态（netMode==='off' 时全部不生效，单人路径零影响） ---- */
let keys2 = {};             // 玩家2 的输入：房主侧由客方上报写入，驱动 player2
let player2 = null;         // 玩家2 坦克
let lives2 = 2;             // 玩家2 独立命数
let netMode = 'off';        // 'off' | 'host' | 'guest'
let netSendAcc = 0;         // 网络发包节流累加器（20Hz）
let coopReady = false;      // 客方是否已收到首帧快照
let coopDropped = false;    // 对方掉线（重连窗口内）
let coopRoomCode = '';
let grenadeBlasts = [];     // 敌人拾取手雷后的引信警示（{px,py,t,r}）
let hintMsg = '', hintT = 0;
function hint(msg){ hintMsg = msg; hintT = 1.6; }
/* AI 寻路距离场 */
let distToPlayer = null, distToPlayer2 = null, distToBase = null, fieldTimer = 0;
try { hiScore = +(localStorage.getItem('tank1998_hi') || 0); } catch(e) {}

/* ---- 无障碍：减少闪烁（满足 WCAG 2.3.1「每秒闪烁不超过 3 次」）----
 * 默认跟随系统 prefers-reduced-motion；工具栏开关可手动覆盖并持久化。
 * 开启后：周期性闪烁降为 <=3Hz；会「消失」的闪烁（无敌隐身 / 道具临期）改为常显 + 静态描边；
 * 受击白闪关闭。 */
let reduceMotion = false;
try {
  const saved = localStorage.getItem('tank1998_reduce_motion');
  if (saved === '1') reduceMotion = true;
  else if (saved === null && typeof matchMedia === 'function' &&
           matchMedia('(prefers-reduced-motion: reduce)').matches) reduceMotion = true;
} catch(e) {}
const FLASH_HZ_MAX = 3;                       // 合规上限：每秒闪烁次数
function flashOn(hz){                          // true = 本帧显示（用于周期闪烁）
  const f = reduceMotion ? Math.min(hz, FLASH_HZ_MAX) : hz;
  return Math.floor(gameTime * f) % 2 === 0;
}
function setReduceMotion(on){
  reduceMotion = !!on;
  try { localStorage.setItem('tank1998_reduce_motion', reduceMotion ? '1' : '0'); } catch(e) {}
  syncReduceMotionBtn();
}

function enemySpeedMul(){ return tier().speed; }   // 档位速度（原为线性 1+0.08*(level-1) 且在 1.6 封顶）

/* ================= 实体 ================= */
let __tankId = 1;
function makeTank(x, y, dir, kind, opts){
  opts = opts || {};
  const isP = kind === 'player';
  const def = isP ? {speed:2.6, hp:playerMaxHp(), fire:0.4} : ETYPES[kind];
  const spd = def.speed * (isP ? 1 : enemySpeedMul());
  // 档位加血：每档整体 +0/+1/+2（红色道具敌人与首领不吃这档加成）
  const hpBonus = (!isP && kind !== 'bonus' && kind !== 'boss') ? tier().hp : 0;
  const hp = def.hp + hpBonus;
  return {
    id: __tankId++,
    x, y, px: x*TILE + TILE/2, py: y*TILE + TILE/2, dir, kind,
    speed: spd, hp, maxHp: hp, fire: def.fire,
    movingTo: null, pendingDir: null,
    aiT: Math.random()*0.08, fireT: 1 + Math.random()*2,
    invuln: opts.invuln || 0, dead: false, deadTimer: 0,
    score: def.score || 0, isPlayer: isP,
    power: opts.power || 1, bulletCd: 0,
    amphibious: 0,
    /* ---- 武器与状态（状态挂 tank，新关卡重建即清零） ---- */
    gun: 'normal', ammo: 0,
    burnT: 0, burnAcc: 0, burnGen: 0,
    slowT: 0, overheatT: 0, hitFlash: 0,
    role: Math.random() < 0.55 ? 'hunter' : 'raider', // 追玩家 / 直扑基地
  };
}

function canEnter(t, cell){
  if (cell.x < 0 || cell.x >= COLS || cell.y < 0 || cell.y >= ROWS) return false;
  const v = map[cell.y][cell.x];
  if (v === BRICK || v === STEEL || v === BASE) return false;
  if (v === WATER && !(t && t.amphibious > 0)) return false;   // 两栖道具可过水
  const players = [];
  if (player && !player.dead) players.push(player);
  if (player2 && !player2.dead) players.push(player2);
  const tanks = players.concat(enemies.filter(e => !e.dead));
  for (const o of tanks){
    if (o === t) continue;
    if ((o.x === cell.x && o.y === cell.y) ||
        (o.movingTo && o.movingTo.x === cell.x && o.movingTo.y === cell.y)) return false;
  }
  return true;
}

/* ---- 双人合作：玩家集合 / 命数判定（netMode==='off' 时 player2 为 null，等价于单人） ---- */
function playerTargets(){
  const list = [];
  if (player && !player.dead) list.push(player);
  if (player2 && !player2.dead) list.push(player2);
  return list;
}
function bothOutOfLives(){ return lives <= 0 && (player2 == null || lives2 <= 0); }

function snapToGrid(t){
  const gx = Math.round((t.px - TILE/2) / TILE);
  const gy = Math.round((t.py - TILE/2) / TILE);
  t.x = gx; t.y = gy;
  t.px = gx*TILE + TILE/2; t.py = gy*TILE + TILE/2;
}

function updateTankMove(t, dt){
  // 到达格心后，应用待转向（换向不打断当前格移动，手感更顺）
  if (!t.movingTo && t.pendingDir != null){
    t.dir = t.pendingDir;
    t.pendingDir = null;
  }
  // 减速只作用于实际位移，不改 t.speed 本身（t.speed 已被关卡系数一次性缩放，反复乘会漂移）
  const sp = t.speed * TILE * tileSpeedMul(t) * statusSpeedMul(t);
  // 方向改变时，先把坦克对齐到最近格心，再按新方向起步，避免斜向漂移/穿墙
  if (t.movingTo){
    const d = DIRS[t.dir];
    const wantX = t.x + d.dx, wantY = t.y + d.dy;
    if (t.movingTo.x !== wantX || t.movingTo.y !== wantY){
      snapToGrid(t);
      t.movingTo = null;
    }
  }
  if (t.movingTo){
    const d = DIRS[t.dir];
    const tx = t.movingTo.x*TILE + TILE/2, ty = t.movingTo.y*TILE + TILE/2;
    const nx = t.px + d.dx*sp*dt, ny = t.py + d.dy*sp*dt;
    const dist = Math.abs(nx - tx) + Math.abs(ny - ty);
    const step = Math.abs(d.dx*sp*dt) + Math.abs(d.dy*sp*dt);
    if (dist <= step + 0.01){
      t.px = tx; t.py = ty;
      t.x = t.movingTo.x; t.y = t.movingTo.y;
      t.movingTo = null;
      if (t.pendingDir != null){ t.dir = t.pendingDir; t.pendingDir = null; }
      const d2 = DIRS[t.dir];
      const nc = {x: t.x + d2.dx, y: t.y + d2.dy};
      if (canEnter(t, nc)) t.movingTo = nc;
    } else {
      t.px = nx; t.py = ny;
    }
  } else {
    const d = DIRS[t.dir];
    const nc = {x: t.x + d.dx, y: t.y + d.dy};
    if (canEnter(t, nc)) t.movingTo = nc;
  }
}

function countBullets(t){
  let n = 0;
  for (const b of bullets) if (b.owner === t && !b.dead) n++;
  return n;
}

/* 存活计数 / 原地剔除：游戏循环里原先每帧多处写 enemies.filter(...).length，
 * 每次都会新建数组——60fps 下持续产生垃圾，表现为偶发 GC 掉帧。
 * 改为无分配的普通循环，语义完全一致。 */
function countAlive(list){
  let n = 0;
  for (let i = 0; i < list.length; i++) if (!list[i].dead) n++;
  return n;
}
function remainEnemyCount(){ return enemyQueue.length + countAlive(enemies); }

/* 弹速与 power 线性相关 —— 吞噬降级后必须按新等级重算，
 * 否则会出现「2 级外形顶着 3 级速度飞」的手感漂移。 */
function bulletSpeed(owner, power){
  return ((owner && owner.isPlayer) ? 260 : 240) + ((power || 1) - 1) * 45;
}
/* 朝向 → 弧度：dir 0=上(-PI/2) 1=右(0) 2=下(PI/2) 3=左(PI) */
function angFor(dir){ return dir * Math.PI / 2 - Math.PI / 2; }

function fireBullet(t){
  const d = DIRS[t.dir];
  const power = t.power || 1;
  const spd = bulletSpeed(t, power);
  // 弹药耗尽自动退回普通弹
  if (t.gun && t.gun !== 'normal' && t.ammo <= 0){ t.gun = 'normal'; t.ammo = 0; }
  const useGun = (t.gun && t.gun !== 'normal' && t.ammo > 0) ? t.gun : 'normal';
  const ug = GUNS[useGun] || GUNS.normal;
  if (useGun !== 'normal') t.ammo--;             // 每次扣 1（散弹齐射 3 发也只扣 1）
  const mk = (ang) => ({
    px: t.px + d.dx*16, py: t.py + d.dy*16,
    dir: t.dir, ang, speed: spd * (ug.speedK || 1),
    owner: t, dead: false, power,
    gun: useGun, hitIds: null, clashCd: 0,
    brickLeft: ug.brickPierce || 0, pierceLeft: ug.pierce || 0,
  });
  if (ug.spread){
    // 扇形 ±22°：绕开「同屏弹数 = power」的上限，散弹枪的卖点正在于此
    for (let i = 0; i < ug.spread; i++){
      const off = (i - (ug.spread - 1) / 2) * (22 * Math.PI / 180);
      bullets.push(mk(angFor(t.dir) + off));
    }
  } else {
    bullets.push(mk(angFor(t.dir)));
  }
  sfx.shoot();
}

function addExplosion(px, py, kind){
  explosions.push({ px, py, kind: kind||'small', t:0, dur: kind==='big' ? 0.55 : kind==='spark' ? 0.16 : 0.3 });
}
/* FC 经典出生四角星闪烁 */
function addSpawnFx(x, y){
  explosions.push({ px: x, py: y, kind: 'spawn', t: 0, dur: 0.9 });
}

/* ================= AI：BFS 距离场 ================= */
function bfsField(ty, tx){
  if (ty < 0 || ty >= ROWS || tx < 0 || tx >= COLS) return null;
  const dist = Array.from({length: ROWS}, () => Array(COLS).fill(Infinity));
  dist[ty][tx] = 0;
  const q = [[ty, tx]];
  let head = 0;
  while (head < q.length){
    const [y, x] = q[head++];
    for (const d of DIRS){
      const ny = y + d.dy, nx = x + d.dx;
      if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS) continue;
      if (dist[ny][nx] !== Infinity) continue;
      const v = map[ny][nx];
      if (v === BRICK || v === STEEL || v === BASE) continue;
      dist[ny][nx] = dist[y][x] + 1;
      q.push([ny, nx]);
    }
  }
  return dist;
}
function refreshFields(){
  distToPlayer = (player && !player.dead) ? bfsField(player.y, player.x) : null;
  distToPlayer2 = (player2 && !player2.dead) ? bfsField(player2.y, player2.x) : null;
  distToBase = bfsField(22, 12) || bfsField(23, 12);   // 基地上方
}
/* 沿方向扫描，看能否直接打到玩家/基地 */
function scanDir(e, d, maxLen){
  const dd = DIRS[d];
  for (let i = 1; i <= maxLen; i++){
    const x = e.x + dd.dx*i, y = e.y + dd.dy*i;
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return null;
    const v = map[y][x];
    if (v === STEEL || v === BRICK) return null;       // 挡住视线
    if (v === BASE) return {kind:'base', dist:i};
    if (player && !player.dead && player.invuln <= 0 && player.x === x && player.y === y) return {kind:'player', dist:i};
    if (player2 && !player2.dead && player2.invuln <= 0 && player2.x === x && player2.y === y) return {kind:'player', dist:i};
  }
  return null;
}
function scanForTarget(e){
  let best = null;
  for (let d = 0; d < 4; d++){
    const r = scanDir(e, d, 14);
    if (r && (r.kind === 'player' || r.kind === 'base')){
      if (!best || r.dist < best.dist) best = { dir:d, dist:r.dist, kind:r.kind };
    }
  }
  return best;
}
/* 挡路砖墙 → 开火打通 */
function tryShootBrick(e, field){
  if (!field) return false;
  const cur = field[e.y][e.x];
  let bestD = -1, bestV = cur;
  for (let d = 0; d < 4; d++){
    const bx = e.x + DIRS[d].dx, by = e.y + DIRS[d].dy;
    if (bx < 0 || bx >= COLS || by < 0 || by >= ROWS) continue;
    if (map[by][bx] !== BRICK) continue;
    const ax = bx + DIRS[d].dx, ay = by + DIRS[d].dy;
    if (ax < 0 || ax >= COLS || ay < 0 || ay >= ROWS) continue;
    const behind = field[ay][ax];
    if (behind !== Infinity && behind < bestV){ bestV = behind; bestD = d; }
  }
  if (bestD >= 0){ e.dir = bestD; e.fireT = 0; return true; }
  return false;
}
/* 按距离场选方向 */
function pickDirByField(e, field){
  const opts = [];
  for (let d = 0; d < 4; d++){
    const cell = {x: e.x + DIRS[d].dx, y: e.y + DIRS[d].dy};
    if (!canEnter(e, cell)) continue;
    const v = field ? field[cell.y][cell.x] : 0;
    opts.push({ d, v });
  }
  if (!opts.length) return null;
  if (!field) return pick(opts).d;
  opts.sort((a, b) => a.v - b.v);
  const smart = tier().smart;   // 档位 AI 命中率（原为 0.62+0.03*level 且在 0.92 封顶）
  let idx = (Math.random() < smart || opts.length === 1) ? 0 : 1;
  // 尽量避免原地掉头
  if (opts[idx].d === (e.dir + 2) % 4 && opts.length > 1) idx = idx === 0 ? 1 : 0;
  return opts[idx].d;
}
/* 敌人抢道具：仅 hunter、仅 5 格内、仅当能真正缩短距离时转向 */
function tryGrabItem(e){
  if (e.role !== 'hunter' || !items.length) return false;
  if (Math.random() > ENEMY_ITEM_GREED) return false;
  let best = null, bd = Infinity;
  for (const it of items){
    if (it.dead) continue;
    const d = Math.abs(it.x - e.x) + Math.abs(it.y - e.y);
    if (d > 0 && d < bd){ bd = d; best = it; }
  }
  if (!best || bd > 5) return false;
  const opts = [];
  for (let d = 0; d < 4; d++){
    const cell = { x: e.x + DIRS[d].dx, y: e.y + DIRS[d].dy };
    if (!canEnter(e, cell)) continue;
    const nd = Math.abs(best.x - cell.x) + Math.abs(best.y - cell.y);
    if (nd < bd) opts.push({ d, v: nd });
  }
  if (!opts.length) return false;
  opts.sort((a, b) => a.v - b.v);
  e.dir = opts[0].d;
  e.aiT = 0.04;
  return true;
}
function enemyThink(e){
  // 1) 直线瞄准：看到玩家/基地立刻转向开火
  const aim = scanForTarget(e);
  if (aim){
    e.dir = aim.dir;
    e.fireT = Math.min(e.fireT, 0.05);
    e.aiT = 0.3 + Math.random()*0.3;
    return;
  }
  // 2) 抢道具：hunter 型、道具有限距离内才绕路（抢太狠玩家永远拿不到道具，正反馈会断）
  if (tryGrabItem(e)) return;
  // 3) 目标选择：追最近玩家 or 直扑基地（双人下同时威胁两个玩家）
  const dp = distToPlayer ? distToPlayer[e.y][e.x] : Infinity;
  const dp2 = distToPlayer2 ? distToPlayer2[e.y][e.x] : Infinity;
  const db = distToBase   ? distToBase[e.y][e.x]   : Infinity;
  const dmin = Math.min(dp, dp2);
  const useP2 = (distToPlayer2 && dp2 <= dp);
  let field = distToBase;
  if (e.role === 'hunter' && dmin !== Infinity && dmin <= 30) field = useP2 ? distToPlayer2 : distToPlayer;
  else if (dmin !== Infinity && dmin < db) field = useP2 ? distToPlayer2 : distToPlayer;
  // 3) 有砖挡路且打得通 → 开火
  if (Math.random() < 0.65 && tryShootBrick(e, field)){ e.aiT = 0.25 + Math.random()*0.3; return; }
  // 4) 寻路移动（决策后立刻继续走，避免每格停顿）
  const d = pickDirByField(e, field);
  if (d != null) e.dir = d;
  else e.dir = (Math.random()*4) | 0;
  e.aiT = 0.04;
}

/* ================= 更新 ================= */
function updatePlayer(dt){
  if (player.dead){
    player.deadTimer -= dt;
    if (player.deadTimer <= 0 && lives > 0){
      player = makeTank(PLAYER_SPAWN.x, PLAYER_SPAWN.y, 0, 'player', {invuln:2, power: 1});
      addSpawnFx(player.px, player.py);
      sfx.spawn();
    }
    return;
  }
  tickStatus(player, dt);   // 统一衰减：invuln / amphibious / burn / slow / overheat / hitFlash
  /* 老鹰无敌倒计时：按真实时间递减，并与 invuln 保持同步 */
  if (playerEagle > 0){
    playerEagle = Math.max(0, playerEagle - dt);
    if (player.invuln < playerEagle) player.invuln = playerEagle;
  }
  if (freezePlayer > 0) return;   // 被时钟冻结：不动也不能射

  const up = keys.ArrowUp || keys.KeyW, down = keys.ArrowDown || keys.KeyS,
        left = keys.ArrowLeft || keys.KeyA, right = keys.ArrowRight || keys.KeyD;
  let want = -1;
  if (up) want = 0;
  else if (right) want = 1;
  else if (down) want = 2;
  else if (left) want = 3;

  if (want >= 0){
    if (player.dir !== want){
      if (player.movingTo) player.pendingDir = want;   // 走完当前格再转向
      else player.dir = want;
    }
    updateTankMove(player, dt);
  } else {
    if (player.movingTo) snapToGrid(player);
    player.movingTo = null;
    if (player.pendingDir != null){ player.dir = player.pendingDir; player.pendingDir = null; }
  }

  if ((keys.Space || keys.KeyJ) && player.overheatT <= 0){
    player.bulletCd -= dt;
    if (player.bulletCd <= 0 && countBullets(player) < player.power){
      fireBullet(player);
      player.bulletCd = player.fire;
    }
  } else {
    player.bulletCd = Math.min(player.bulletCd, 0.05);
  }
}

/* 双人：玩家2 输入读取 keys2，房主侧由客方上报写入 */
function updatePlayer2(dt){
  if (player2.dead){
    player2.deadTimer -= dt;
    if (player2.deadTimer <= 0 && lives2 > 0){
      player2 = makeTank(PLAYER2_SPAWN.x, PLAYER2_SPAWN.y, 0, 'player', {invuln:2, power: 1});
      addSpawnFx(player2.px, player2.py);
      sfx.spawn();
    }
    return;
  }
  tickStatus(player2, dt);
  /* 老鹰无敌倒计时：与玩家1 同步保护 */
  if (playerEagle > 0){
    playerEagle = Math.max(0, playerEagle - dt);
    if (player2.invuln < playerEagle) player2.invuln = playerEagle;
  }
  if (freezePlayer > 0) return;

  const up = keys2.ArrowUp || keys2.KeyW, down = keys2.ArrowDown || keys2.KeyS,
        left = keys2.ArrowLeft || keys2.KeyA, right = keys2.ArrowRight || keys2.KeyD;
  let want = -1;
  if (up) want = 0;
  else if (right) want = 1;
  else if (down) want = 2;
  else if (left) want = 3;

  if (want >= 0){
    if (player2.dir !== want){
      if (player2.movingTo) player2.pendingDir = want;
      else player2.dir = want;
    }
    updateTankMove(player2, dt);
  } else {
    if (player2.movingTo) snapToGrid(player2);
    player2.movingTo = null;
    if (player2.pendingDir != null){ player2.dir = player2.pendingDir; player2.pendingDir = null; }
  }

  if ((keys2.Space || keys2.KeyJ) && player2.overheatT <= 0){
    player2.bulletCd -= dt;
    if (player2.bulletCd <= 0 && countBullets(player2) < player2.power){
      fireBullet(player2);
      player2.bulletCd = player2.fire;
    }
  } else {
    player2.bulletCd = Math.min(player2.bulletCd, 0.05);
  }
}

function updateEnemy(e, dt){
  if (freezeEnemies > 0) return;
  tickStatus(e, dt);   // 位置保持在冻结早退之后（敌人被冻时护盾暂停，与旧行为一致）
  // 只在格心决策，避免半格 snap 抖动，移动更连贯
  if (!e.movingTo){
    e.aiT -= dt;
    if (e.aiT <= 0) enemyThink(e);
  }
  updateTankMove(e, dt);
  e.fireT -= dt;
  if (e.fireT <= 0 && countBullets(e) < (e.power || 1)){
    if (Math.random() < 0.78) fireBullet(e);
    e.fireT = e.fire * (0.6 + Math.random() * 0.9) * (e.slowT > 0 ? SLOW_FIRE_E : 1);
  }
}

function stepBullet(b, dist){
  if (b.ang == null) b.ang = angFor(b.dir);        // 兼容裸对象（测试 / 旧存档）
  b.px += Math.cos(b.ang) * dist;
  b.py += Math.sin(b.ang) * dist;
  // 追踪弹：转向速率上限 90°/秒，非必中
  const g = GUNS[b.gun] || GUNS.normal;
  if (g.homing){
    const tgt = nearestTarget(b);
    if (tgt){
      const want = Math.atan2(tgt.py - b.py, tgt.px - b.px);
      let diff = want - b.ang;
      while (diff > Math.PI) diff -= Math.PI*2;
      while (diff < -Math.PI) diff += Math.PI*2;
      const maxTurn = (90 * Math.PI / 180) * (dist / Math.max(1, b.speed));
      b.ang += Math.max(-maxTurn, Math.min(maxTurn, diff));
      b.dir = Math.round((b.ang + Math.PI/2) / (Math.PI/2)) & 3;
    }
  }
  if (b.px < 0 || b.px >= PLAY_W || b.py < 0 || b.py >= PLAY_H){ b.dead = true; return; }
  const cx = Math.floor(b.px / TILE), cy = Math.floor(b.py / TILE);
  const tile = map[cy][cx];
  const power = b.power || 1;
  if (tile === BRICK){
    setTile(cy, cx, EMPTY);
    addExplosion(cx*TILE+TILE/2, cy*TILE+TILE/2, 'spark');
    sfx.brick();
    // 穿甲钻 / 激光：钻透砖墙继续前进（有格数上限）
    if (b.brickLeft > 0){ b.brickLeft--; return; }
    b.dead = true;
    return;
  }
  if (tile === STEEL){
    if (power >= 2){                             // 2 级穿甲弹打穿钢板
      setTile(cy, cx, EMPTY);
      addExplosion(cx*TILE+TILE/2, cy*TILE+TILE/2, 'spark');
      sfx.steel();
    } else {
      addExplosion(b.px, b.py, 'spark');
      sfx.steel();
    }
    b.dead = true;   // 激光也被钢板挡住：保留钢墙作为绝对掩体，star 成长线才不会贬值
    return;
  }
  if (tile === WATER){
    if (power >= 3){                             // 3 级毁灭弹蒸发水面
      setTile(cy, cx, EMPTY);
      b.dead = true;
      addExplosion(cx*TILE+TILE/2, cy*TILE+TILE/2, 'spark');
      sfx.brick();
      return;
    }
    // 低等级子弹穿过水面
  }
  if (tile === BASE){
    b.dead = true;
    destroyBase();
    return;
  }
  const targets = b.owner.isPlayer ? enemies : playerTargets();   // 敌弹可伤两名玩家
  for (const t of targets){
    if (t.dead || t.invuln > 0) continue;
    if (b.hitIds && b.hitIds.indexOf(t.id) >= 0) continue;   // 穿透弹不重复扣血
    if (Math.abs(b.px - t.px) < 11 && Math.abs(b.py - t.py) < 11){
      applyHit(b, t);
      if (b.dead) break;
    }
  }
}

function nearestTarget(b){
  const list = b.owner && b.owner.isPlayer ? enemies : playerTargets();
  let best = null, bd = Infinity;
  for (const t of list){
    if (t.dead) continue;
    const d = Math.abs(t.px - b.px) + Math.abs(t.py - b.py);
    if (d < bd){ bd = d; best = t; }
  }
  return best;
}

/* 命中结算：伤害 + 元素效果 + 穿透判定 */
function applyHit(b, t){
  const g = GUNS[b.gun] || GUNS.normal;
  if (g.chain){
    // 电磁链：跳跃不分敌我，敌人用它会电到自己队友
    let cur = t, hitIds = [t.id];
    for (let i = 0; i < g.chain; i++){
      if (!cur || cur.dead) break;
      damageTank(cur, 1, 'chain');
      const next = chainNext(cur, hitIds);
      if (!next) break;
      hitIds.push(next.id);
      addExplosion((cur.px + next.px) / 2, (cur.py + next.py) / 2, 'spark');
      cur = next;
    }
    b.dead = true;
    return;
  }
  if (g.burn){
    if (t.isPlayer) t.overheatT = Math.max(t.overheatT, OVERHEAT_TIME);  // 玩家不 DOT，改枪管过热
    else { t.burnT = Math.max(t.burnT, BURN_TIME); t.burnAcc = 0; }
  }
  if (g.slow) t.slowT = Math.max(t.slowT, t.isPlayer ? SLOW_TIME_P : SLOW_TIME_E);
  damageTank(t, 1, 'bullet');
  if (b.pierceLeft > 0){                 // 激光 / 穿甲钻：贯穿
    b.pierceLeft--;
    if (!b.hitIds) b.hitIds = [];
    b.hitIds.push(t.id);
  } else {
    b.dead = true;
  }
}
function chainNext(from, exclude){
  let best = null, bd = Infinity;
  for (const t of enemies){
    if (t.dead || exclude.indexOf(t.id) >= 0) continue;
    const d = Math.abs(t.px - from.px) + Math.abs(t.py - from.py);
    if (d < 2*TILE && d < bd){ bd = d; best = t; }
  }
  if (player && !player.dead && exclude.indexOf(player.id) < 0){
    const d = Math.abs(player.px - from.px) + Math.abs(player.py - from.py);
    if (d < 2*TILE && d < bd) best = player;
  }
  if (player2 && !player2.dead && exclude.indexOf(player2.id) < 0){
    const d = Math.abs(player2.px - from.px) + Math.abs(player2.py - from.py);
    if (d < 2*TILE && d < bd) best = player2;
  }
  return best;
}

/* ---- 子弹等级吞噬 ----
 * 规则：仅敌我双方相遇才判定（同阵营互不干扰，否则 power2/3 的两发弹会自己撞自己，
 *       升级火力反而变成自我消耗）。
 *       等级相同 → 同归于尽；等级不同 → 高级吃掉低级，新等级 = |高 - 低|。
 *       2v1→1 / 3v2→1 / 3v1→2，低级弹消失，高级弹保留归属与朝向继续飞。
 * 尺寸与渲染体严格一致：Lv1 4x10 / Lv2 6x12 / Lv3 8x14，随朝向旋转。
 */
function bulletHalfSize(b){
  const p = Math.max(1, Math.min(3, b.power || 1));
  const w = p * 2 + 2, h = p * 2 + 8;                 // Lv1 4x10 / Lv2 6x12 / Lv3 8x14
  if (b.ang != null && Math.abs(Math.cos(b.ang)) > 0.01 && Math.abs(Math.sin(b.ang)) > 0.01){
    return { hw: w/2 + 1, hh: w/2 + 1 };              // 斜向（散弹）用方形近似
  }
  return (b.dir % 2 === 0) ? { hw: w/2, hh: h/2 } : { hw: h/2, hh: w/2 };
}
function tryBulletClash(b){
  if (!b.owner || b.clashCd > 0) return false;
  let best = null, bestD = Infinity;
  for (const o of bullets){
    if (o === b || o.dead || !o.owner || o.clashCd > 0) continue;
    if (b.owner.isPlayer === o.owner.isPlayer) continue;   // 同阵营放行
    const A = bulletHalfSize(b), B = bulletHalfSize(o);
    if (!(Math.abs(b.px - o.px) < A.hw + B.hw && Math.abs(b.py - o.py) < A.hh + B.hh)) continue;
    const d = Math.abs(b.px - o.px) + Math.abs(b.py - o.py);
    if (d < bestD){ bestD = d; best = o; }   // 取最近的一颗，而非数组顺序
  }
  if (!best) return false;
  const pb = Math.max(1, b.power || 1), po = Math.max(1, best.power || 1);
  const mx = (b.px + best.px) / 2, my = (b.py + best.py) / 2;
  addExplosion(mx, my, 'spark');
  if (pb === po){                              // 同级：同归于尽
    b.dead = true; best.dead = true;
    sfx.spark();
    return true;
  }
  const win = pb > po ? b : best, lose = pb > po ? best : b;
  // 只前进不倒退：否则侧面/追尾对撞时子弹会视觉上「弹回去」
  const dv = DIRS[win.dir];
  if ((mx - win.px) * dv.dx + (my - win.py) * dv.dy >= 0){ win.px = mx; win.py = my; }
  win.power = Math.max(1, Math.abs(pb - po));   // 谁先触发都要用差值绝对值，否则低级弹先撞时算成负数
  win.speed = bulletSpeed(win.owner, win.power) * ((GUNS[win.gun] || GUNS.normal).speedK || 1);
  win.clashCd = CLASH_CD;      // 一次交火最多被削一级，防止 3 级弹被杂兵弹幕稀释
  lose.dead = true;
  sfx.steel();
  return win !== b;            // 幸存者继续飞（false），被吃掉则退出子步（true）
}

function updateBullets(dt){
  for (const b of bullets){
    if (b.dead) continue;
    if (b.clashCd > 0) b.clashCd -= dt;
    const total = b.speed * dt;
    // 子步由 5px 收紧到 3px：保证高速对撞时抵消判定不会漏检
    const steps = Math.max(1, Math.ceil(total / 3));
    const stepLen = total / steps;
    for (let i = 0; i < steps && !b.dead; i++){
      stepBullet(b, stepLen);
      if (!b.dead) tryBulletClash(b);
    }
  }
  let bw = 0;   // 原地剔除已死亡子弹（无分配）
  for (let i = 0; i < bullets.length; i++){ const b = bullets[i]; if (!b.dead) bullets[bw++] = b; }
  bullets.length = bw;
}

/* 统一伤害入口：invuln 守卫内聚在这里，
 * 燃烧 DOT 作为新的调用方也必须过这道闸，否则会击穿老鹰 60 秒无敌。 */
function damageTank(t, n, src){
  if (!t || t.dead || t.invuln > 0) return false;
  // 火力护盾：Lv2/Lv3 玩家被子弹/链跳命中时，先扣一级火力抵消本次伤害
  const isBullet = src === 'bullet' || src === 'legacy' || src === 'chain';
  if (t.isPlayer && t.power >= 2 && isBullet){
    t.power = 1;
    t.hitFlash = 0.18;
    addExplosion(t.px, t.py, 'spark');
    sfx.steel();
    return true;
  }
  t.hp -= (n || 1);
  t.hitFlash = 0.12;
  if (t.hp <= 0){
    t.dead = true;
    addExplosion(t.px, t.py, 'big');
    if (t.isPlayer){
      sfx.playerBoom();
      if (t === player) lives--;
      else if (t === player2) lives2--;
      t.deadTimer = 1.6;
      if (bothOutOfLives()){ overReason = '生命耗尽'; gameOver(); }
    } else {
      sfx.boom();
      addScore(t.score);
      killCount++;
      if (t.kind === 'bonus') spawnItem(t.x, t.y, true);          // 红色敌人必掉
      else if (t.kind === 'boss'){                                 // 首领：必掉双道具（force 可越过同屏上限）
        spawnItem(t.x, t.y, true);
        spawnItem(t.x, t.y, true);
      }
      else if (Math.random() < ITEM_DROP_RATE || killCount % KILL_BONUS_EVERY === 0) spawnItem(t.x, t.y);
      if (src === 'burn' && (t.burnGen || 0) < BURN_GEN) spreadBurn(t);   // 燃烧致死 → 传染
    }
  } else {
    addExplosion(t.px, t.py, 'spark');
    sfx.steel();
    // 多血档位：受击后 1 秒无敌，避免被连击瞬间打穿
    if (t.isPlayer && playerMaxHp() > 1) t.invuln = Math.max(t.invuln, 1.0);
  }
  return true;
}
function hitTank(t){ return damageTank(t, 1, 'legacy'); }   // 兼容旧调用点

/* 燃烧致死传染：1 格内敌人被点燃（半衰），最多 2 代 */
function spreadBurn(src){
  for (const e of enemies){
    if (e.dead || e.invuln > 0) continue;
    if (Math.abs(e.px - src.px) < TILE && Math.abs(e.py - src.py) < TILE){
      e.burnT = Math.max(e.burnT, BURN_TIME * 0.4);
      e.burnGen = (src.burnGen || 0) + 1;
      e.burnAcc = 0;
    }
  }
}

/* 统一状态衰减：每加一种道具只需在表里加一行，不用复制粘贴衰减代码 */
function statusSpeedMul(t){
  let m = 1;
  if (t.slowT > 0) m *= (t.isPlayer ? SLOW_MUL_P : SLOW_MUL_E);
  return Math.max(0.2, m);
}
function tickStatus(t, dt){
  if (!t || t.dead) return;
  if (t.invuln > 0) t.invuln -= dt;
  if (t.amphibious > 0) t.amphibious -= dt;
  if (t.slowT > 0) t.slowT = Math.max(0, t.slowT - dt);
  if (t.overheatT > 0) t.overheatT = Math.max(0, t.overheatT - dt);
  if (t.hitFlash > 0) t.hitFlash = Math.max(0, t.hitFlash - dt);
  if (t.burnT > 0){
    // 冻结 / 无敌期间 DOT 暂停：规则统一，避免控制道具互相抵消、护盾被 DOT 无视
    const halted = t.invuln > 0 || (t.isPlayer ? freezePlayer > 0 : freezeEnemies > 0);
    if (!halted){
      t.burnT = Math.max(0, t.burnT - dt);
      t.burnAcc += dt;
      let guard = 0;
      while (t.burnAcc >= BURN_TICK && !t.dead && guard++ < 10){
        t.burnAcc -= BURN_TICK;
        damageTank(t, 1, 'burn');
      }
    }
  }
}

function destroyBase(){
  if (!baseAlive) return;
  baseAlive = false;
  setTile(24, 12, EMPTY); setTile(24, 13, EMPTY); setTile(25, 12, EMPTY); setTile(25, 13, EMPTY);
  addExplosion(12*TILE+TILE, 24*TILE+TILE, 'big');
  addExplosion(12*TILE+TILE, 24*TILE+TILE, 'big');
  sfx.playerBoom();
  overReason = '基地被摧毁';
  gameOver();
}

function gameOver(){
  if (state !== 'playing') return;
  state = 'over';
  startLockT = gameTime + 0.8;   // 死亡瞬间手指乱点，防误触重开
  sfx.over();
  if (score > hiScore){
    hiScore = score;
    try { localStorage.setItem('tank1998_hi', String(hiScore)); } catch(e) {}
  }
}

/* 两层掉落池：武器直接并入会稀释火力成长（star 22% → 13%），
 * 改为经典池 50% / 武器池 50%，所有关卡均可能掉落武器。 */
function rollItemType(){
  if (level >= WEAPON_UNLOCK_LEVEL && Math.random() > CLASSIC_POOL_RATE){
    let total = WEAPON_WEIGHT.reduce((a, b) => a + b, 0), r = Math.random() * total;
    for (let i = 0; i < WEAPON_TYPES.length; i++){
      r -= WEAPON_WEIGHT[i];
      if (r <= 0) return WEAPON_TYPES[i];
    }
  }
  let total = ITEM_WEIGHT.reduce((a, b) => a + b, 0), r = Math.random() * total;
  let type = 'star';
  for (let i = 0; i < ITEM_TYPES.length; i++){
    r -= ITEM_WEIGHT[i];
    if (r <= 0){ type = ITEM_TYPES[i]; break; }
  }
  return type;
}
function spawnItem(gx, gy, force){
  if (items.length >= ITEM_MAX && !force) return;
  if (items.length >= ITEM_MAX + 1) return;
  const type = rollItemType();
  const cands = [];
  for (let y = 2; y < ROWS - 2; y++) for (let x = 1; x < COLS - 1; x++){
    if (isWalkableGround(map[y][x])) cands.push({x, y});
  }
  const pos = cands.length ? cands[(Math.random()*cands.length)|0] : {x:gx, y:gy};
  items.push({ x:pos.x, y:pos.y, px:pos.x*TILE+TILE/2, py:pos.y*TILE+TILE/2, type, t:0 });
  sfx.spawn();
}

/* 测试用：在玩家附近直接投放一颗老鹰道具（E 键） */
function debugDropEagle(){
  if (state !== 'playing' || !player || player.dead) return;
  const d = DIRS[player.dir];
  const cands = [
    { x: player.x + d.dx * 2, y: player.y + d.dy * 2 },
    { x: player.x + d.dx,     y: player.y + d.dy },
    { x: player.x,            y: player.y },
  ];
  for (const c of cands){
    if (c.x < 1 || c.x >= COLS - 1 || c.y < 2 || c.y >= ROWS - 2) continue;
    if (!isWalkableGround(map[c.y][c.x])) continue;
    items.push({ x:c.x, y:c.y, px:c.x*TILE+TILE/2, py:c.y*TILE+TILE/2, type:'eagle', t:0 });
    sfx.spawn();
    return;
  }
}

/* ================= 道具拾取（敌我皆可） ================= */
/* 武器拾取：叠加在火力等级之上，不替换 power */
function pickupWeapon(type, tank){
  if (!tank.isPlayer && ENEMY_NO_GUN[type]) type = 'normal';   // 追踪弹敌军禁用
  if (type === 'normal'){ tank.gun = 'normal'; tank.ammo = 0; return; }
  const g = GUNS[type];
  // 已持有同种武器 → 补给 +3 发；换枪 → 余弹重置（已生效的燃烧/减速保留，不影响换枪决策）
  if (tank.gun === type) tank.ammo += 3;
  else tank.ammo = g.ammo;
  tank.gun = type;
  sfx.itemPickup();
  hint((tank.isPlayer ? '' : '敌军获得 ') + g.name + (tank.isPlayer ? ' ×' + tank.ammo : ''));
}
/* 敌军增援：场上敌人回满血 + 队列提前调出 1 只（队列空则补 1 只） */
function enemyReinforce(){
  for (const e of enemies) if (!e.dead) e.hp = e.maxHp;
  if (!enemyQueue.length) enemyQueue.push('basic');
  spawnTimer = 0;
  hint('敌军增援！');
  sfx.spawn();
}
/* 敌人拾取手雷：范围爆炸，引信期间画红色警示圈（见 drawGrenadeWarn） */
function updateGrenades(dt){
  for (const g of grenadeBlasts) g.t -= dt;
  const fired = grenadeBlasts.filter(g => g.t <= 0);
  grenadeBlasts = grenadeBlasts.filter(g => g.t > 0);
  for (const g of fired){
    addExplosion(g.px, g.py, 'big');
    sfx.boom();
    for (const e of enemies){
      if (e.dead) continue;
      if (Math.abs(e.px - g.px) < g.r && Math.abs(e.py - g.py) < g.r) damageTank(e, 99, 'grenade');
    }
    if (player && !player.dead &&
        Math.abs(player.px - g.px) < g.r && Math.abs(player.py - g.py) < g.r){
      damageTank(player, 1, 'grenade');
    }
    if (player2 && !player2.dead &&
        Math.abs(player2.px - g.px) < g.r && Math.abs(player2.py - g.py) < g.r){
      damageTank(player2, 1, 'grenade');
    }
  }
}

function pickUpItem(it, tank){
  it.dead = true;
  sfx.item();
  const isP = tank.isPlayer;
  if (WEAPON_RING[it.type]){ pickupWeapon(it.type, tank); return; }
  switch(it.type){
    case 'star':
      // 敌人火力封顶 2 级：3 级敌弹会蒸干水塘，永久改变地图连通性
      tank.power = Math.min(isP ? 3 : ENEMY_MAX_POWER, tank.power + 1);
      break;
    case 'grenade':
      if (isP){
        for (const e of enemies){
          if (!e.dead){ e.dead = true; addScore(e.score); addExplosion(e.px, e.py, 'big'); }
        }
        enemies = enemies.filter(e => !e.dead);
        bullets = bullets.filter(b => b.owner.isPlayer);
        sfx.boom();
      } else {
        grenadeBlasts.push({ px: tank.px, py: tank.py, t: GRENADE_FUSE, r: GRENADE_RADIUS * TILE });
        hint('敌军引爆手雷！注意红圈');
        sfx.clock();
      }
      break;
    case 'shield':
      tank.invuln = Math.max(tank.invuln, isP ? SHIELD_TIME : ENEMY_SHIELD_TIME);
      sfx.shield();
      break;
    case 'clock':
      if (isP) freezeEnemies = FREEZE_TIME;
      else freezePlayer = ENEMY_FREEZE_TIME;
      sfx.clock();
      break;
    case 'tank':
      if (tank === player) lives = Math.min(6, lives + 1);
      else if (tank === player2) lives2 = Math.min(6, lives2 + 1);
      else enemyReinforce();
      break;
    case 'amphibious':
      tank.amphibious = isP ? AMPHIBIOUS_TIME : ENEMY_AMPHIBIOUS_TIME;
      sfx.shield();
      break;
    case 'eagle':
      /* 老鹰：立即进入 60 秒无敌。
       * 采用「重置计时器」机制 —— 重复拾取重新计时 60 秒，不做叠加。 */
      if (tank.isPlayer){
        playerEagle = EAGLE_TIME;
        tank.invuln = EAGLE_TIME;
      } else {
        // 敌方拾取退化为普通护盾（6 秒），避免敌军长期无敌破坏关卡平衡
        tank.invuln = ENEMY_SHIELD_TIME;
      }
      sfx.itemPickup();
      break;
  }
}

function collectItems(){
  const tanks = [];
  if (player && !player.dead) tanks.push(player);
  if (player2 && !player2.dead) tanks.push(player2);
  for (const e of enemies) if (!e.dead) tanks.push(e);
  for (const it of items){
    if (it.dead) continue;
    for (const t of tanks){
      const d = Math.abs(t.px - it.px) + Math.abs(t.py - it.py);
      if (d < 14){ pickUpItem(it, t); break; }
    }
  }
}

function spawnEnemy(){
  const free = SPAWN_POINTS.filter(p => canEnter(null, p));
  if (!free.length || !enemyQueue.length) return;
  const p = free[(Math.random()*free.length)|0];
  const kind = enemyQueue.shift();
  const e = makeTank(p.x, p.y, 2, kind, {invuln: 1.6});
  enemies.push(e);
  addSpawnFx(e.px, e.py);
  sfx.spawn();
}

/* ================= 关卡 ================= */
function buildQueue(){
  const T = tier();
  const q = [];
  const total = T.total + (isBossLevel() ? -2 : 0);   // BOSS 关总量略减，抵消首领带来的额外压力
  for (let i = 0; i < total; i++) q.push(pick(T.pool));
  const bonusCount = 4 + Math.min(3, Math.floor(level / 2));   // 红色道具敌人数量
  for (let i = 0; i < bonusCount; i++){
    const pos = 1 + ((Math.random() * (q.length - 1)) | 0);
    q.splice(pos, 0, 'bonus');
  }
  if (isEliteLevel()){                       // 精英关：前段插入精英，开场即高压
    for (let i = 0; i < ELITE_COUNT; i++) q.splice(2 + i, 0, pick(ELITE_TYPES));
    q.splice(0, 0, 'bonus');                 // 顺带保底一个道具敌人，避免精英关太苦
  }
  if (isBossLevel()) q.push('boss');         // BOSS 关：首领压轴
  return q;
}

/* fresh=true 表示「重开一局」：火力等级回到 1 级；
 * 不传 / false 表示「进入下一关」：继承上一关的火力等级（丢命复活同理，见 updatePlayer）。 */
function startLevel(fresh){
  map = buildMap();
  terrainFull = true;   // 换图：地形缓存整张重建
  snapFullNeeded = true; tileDelta = [];   // 换图：网络那边也要重发一次全量地图
  enemies = []; bullets = []; items = []; explosions = []; grenadeBlasts = [];
  enemyQueue = buildQueue();
  spawnTimer = 1.0;
  killCount = 0;
  freezeEnemies = 0; freezePlayer = 0;
  playerEagle = 0;
  levelIntro = LEVEL_INTRO_TIME;   // 幕布开场
  baseAlive = true;
  const carryPower = (!fresh && player && !player.dead) ? (player.power || 1) : 1;   // 下一关继承；重开一局则重置为 1
  player = makeTank(PLAYER_SPAWN.x, PLAYER_SPAWN.y, 0, 'player', {invuln: 2, power: carryPower});
  addSpawnFx(player.px, player.py);
  if (netMode === 'host'){   // 双人房主：同步生成玩家2（客方仅靠快照渲染）
    const carryPower2 = (!fresh && player2 && !player2.dead) ? (player2.power || 1) : 1;
    player2 = makeTank(PLAYER2_SPAWN.x, PLAYER2_SPAWN.y, 0, 'player', {invuln: 2, power: carryPower2});
    addSpawnFx(player2.px, player2.py);
  }
  refreshFields();
  state = 'playing';
}

function startGame(){
  score = 0; lives = 2; level = 1; lives2 = 2;
  nextExtraLifeScore = 2000;
  startLevel(true);   // 重开一局：火力等级归 1
}

/* 统一加分入口：每满 2000 分奖一命 */
function addScore(n){
  score += (n || 0);
  if (score >= nextExtraLifeScore){
    lives = Math.min(6, lives + 1);
    nextExtraLifeScore += 2000;
    hint('得分奖命！');
    sfx.item();
  }
}

function nextLevel(){
  level++;
  startLevel();
}

function update(dt){
  /* FC 幕布开场期间：世界静止，只推进幕布计时 */
  if (levelIntro > 0){ levelIntro = Math.max(0, levelIntro - dt); return; }
  if (hintT > 0) hintT = Math.max(0, hintT - dt);
  if (freezeEnemies > 0) freezeEnemies -= dt;
  if (freezePlayer > 0) freezePlayer -= dt;
  if (state === 'playing'){
    updateGrenades(dt);
    updatePlayer(dt);
    if (netMode === 'host' && player2) updatePlayer2(dt);   // 双人：房主驱动玩家2（输入来自客方）
    for (const e of enemies) updateEnemy(e, dt);
    updateBullets(dt);
    fieldTimer -= dt;
    if (fieldTimer <= 0){ refreshFields(); fieldTimer = 0.35; }
    spawnTimer -= dt;
    const aliveCount = countAlive(enemies);
    if (enemyQueue.length && aliveCount < 4 && spawnTimer <= 0){
      spawnEnemy();
      spawnTimer = 2.0 + Math.random() * 1.2;
    }
    for (const it of items) it.t += dt;
    collectItems();
    /* 原地剔除（无分配）：过期/已拾取的道具、已死亡敌人 */
    let iw = 0;
    for (let i = 0; i < items.length; i++){ const it = items[i]; if (!it.dead && it.t < ITEM_LIFE) items[iw++] = it; }
    items.length = iw;
    let ew = 0;
    for (let i = 0; i < enemies.length; i++){ const e = enemies[i]; if (!e.dead) enemies[ew++] = e; }
    enemies.length = ew;
    if (!enemyQueue.length && !enemies.length && playerTargets().length > 0){
      state = 'clear';
      startLockT = gameTime + 0.8;   // 过关瞬间防误触
      sfx.clear();
      if (score > hiScore){
        hiScore = score;
        try { localStorage.setItem('tank1998_hi', String(hiScore)); } catch(e) {}
      }
    }
  }
  for (const ex of explosions) ex.t += dt;
  let xw = 0;
  for (let i = 0; i < explosions.length; i++){ const ex = explosions[i]; if (ex.t < ex.dur) explosions[xw++] = ex; }
  explosions.length = xw;
}

/* ================= 渲染：地形 ================= */
function px(x, y, w, h, c){ ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

function drawBrick(x, y){
  px(x, y, TILE, TILE, '#D9772E');
  px(x+10, y, 1, TILE, '#A8501A');
  px(x, y+10, TILE, 1, '#A8501A');
  px(x+1, y+1, 8, 8, '#EB9A55');
  px(x+11, y+11, 8, 8, '#EB9A55');
  px(x+11, y+1, 8, 8, '#B4551D');
  px(x+1, y+11, 8, 8, '#B4551D');
  px(x+1, y+1, 8, 1, '#FFC08A');
  px(x+11, y+11, 8, 1, '#FFC08A');
}
function drawSteel(x, y){
  px(x, y, TILE, TILE, '#C7CDD4');
  px(x, y, TILE, 1, '#8F979F');
  px(x, y+TILE-1, TILE, 1, '#8F979F');
  px(x, y, 1, TILE, '#8F979F');
  px(x+TILE-1, y, 1, TILE, '#8F979F');
  px(x+3, y+3, 4, 4, '#98A2AD');
  px(x+13, y+3, 4, 4, '#98A2AD');
  px(x+3, y+13, 4, 4, '#98A2AD');
  px(x+13, y+13, 4, 4, '#98A2AD');
  px(x+4, y+4, 2, 2, '#E8EBEF');
  px(x+14, y+4, 2, 2, '#E8EBEF');
  px(x+4, y+14, 2, 2, '#E8EBEF');
  px(x+14, y+14, 2, 2, '#E8EBEF');
}
/* 水的实际绘制（供精灵烘焙与回退共用）：w=波纹相位 */
function paintWater(w, ox, oy){
  px(ox, oy, TILE, TILE, '#1F6FC0');
  px(ox+1, oy + (w ? 5 : 13), 18, 5, w ? '#4FA3E8' : '#2E86D8');
  px(ox+3, oy+2, 5, 2, 'rgba(255,255,255,0.30)');
  px(ox+12, oy+16, 5, 2, 'rgba(255,255,255,0.18)');
}
/* 水：波纹只有两个相位，漂移相位由格子坐标决定 → 每格一次 drawImage */
function drawWater(x, y){
  initTileSprites();
  const phase = (Math.floor(gameTime * (reduceMotion ? 0 : 3)) + Math.floor(y/TILE) + Math.floor(x/TILE)) & 1;
  const sp = tileSprites && tileSprites.water[phase];
  if (sp) ctx.drawImage(sp, x, y, TILE, TILE);
  else paintWater(phase === 0, x, y);   // 回退（无 canvas 环境）
}
/* 树的实际绘制（供精灵烘焙共用）。树在一关内不会被破坏，外观恒定。 */
function paintTree(ox, oy){
  px(ox+2, oy+2, 16, 16, '#12481C');
  ctx.fillStyle = '#2E8B3A';
  ctx.beginPath(); ctx.arc(ox+6, oy+6, 6, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(ox+14, oy+13, 5, 0, 7); ctx.fill();
  ctx.fillStyle = '#46B455';
  ctx.beginPath(); ctx.arc(ox+5, oy+12, 3.5, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(ox+13, oy+5, 3, 0, 7); ctx.fill();
  px(ox+8, oy+14, 4, 4, '#5A3A16');
}
function drawTree(x, y){
  initTileSprites();
  const sp = tileSprites && tileSprites.tree;
  if (sp) ctx.drawImage(sp, x, y, TILE, TILE);
  else paintTree(x, y);
}

/* 弹体：形状只由「火力等级 + 武器配色」决定，与位置无关 →
 * 烘焙成 16x20 精灵（中心在 8,10），渲染时一次 setTransform + 一次 drawImage。
 * 取代原先每发子弹的 save/translate/rotate + 3 次 fillRect + restore。 */
const BULLET_SPR_W = 16, BULLET_SPR_H = 20;
function paintBullet(gc, p, ox, oy){
  if (p === 1){
    px(ox-2, oy-5, 4, 10, gc);
    px(ox-1, oy-4, 2, 8, '#FFD23F');
  } else if (p === 2){
    px(ox-3, oy-6, 6, 12, gc);
    px(ox-2, oy-5, 4, 10, '#FF6A00');
    px(ox-1, oy-4, 2, 8, '#FFD23F');
  } else {
    px(ox-4, oy-7, 8, 14, gc);
    px(ox-3, oy-6, 6, 12, '#FF2D2D');
    px(ox-1.5, oy-5, 3, 10, '#FFD23F');
  }
}
function bulletSprite(gun, power){
  if (!bulletSprites) bulletSprites = Object.create(null);
  const key = gun + ':' + power;
  let sp = bulletSprites[key];
  if (sp === undefined){
    const gc = (GUNS[gun] || GUNS.normal).color;
    sp = makeSprite(BULLET_SPR_W, BULLET_SPR_H, () => paintBullet(gc, power, BULLET_SPR_W/2, BULLET_SPR_H/2));
    bulletSprites[key] = sp;
  }
  return sp;
}
function drawDesert(x, y){
  px(x, y, TILE, TILE, '#DDA63F');
  px(x+3, y+4, 3, 3, '#C48C27');
  px(x+13, y+11, 3, 3, '#C48C27');
  px(x+9, y+16, 3, 3, '#C48C27');
  px(x+9, y+3, 3, 3, '#F0C866');
  px(x+2, y+15, 3, 3, '#F0C866');
  px(x+15, y+6, 2, 2, '#F0C866');
}
function drawSwamp(x, y){
  px(x, y, TILE, TILE, '#39452A');
  ctx.fillStyle = '#54683A';
  ctx.beginPath(); ctx.arc(x+6, y+6, 4.5, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(x+14, y+15, 3.5, 0, 7); ctx.fill();
  ctx.fillStyle = '#6E8547';
  ctx.beginPath(); ctx.arc(x+13, y+5, 2.5, 0, 7); ctx.fill();
  px(x+10, y+3, 4, 2, '#2A3320');
  px(x+4, y+14, 4, 2, '#2A3320');
  px(x+15, y+9, 3, 2, '#2A3320');
}
function drawSnow(x, y){
  px(x, y, TILE, TILE, '#E4EAF0');
  px(x+2, y+3, 4, 4, '#FFFFFF');
  px(x+13, y+8, 4, 4, '#FFFFFF');
  px(x+6, y+14, 4, 4, '#FFFFFF');
  px(x+15, y+3, 3, 2, '#C4D2DE');
  px(x+3, y+12, 2, 2, '#C4D2DE');
  px(x+8, y+8, 3, 3, 'rgba(255,255,255,0.85)');
}

/* ================= 渲染：老鹰基地 ================= */
const EAGLE_PIX = [
  'DD................DD',
  'DDD..............DDD',
  '.DDD............DDD.',
  '.DDDD...WWWW...DDDD.',
  '..DDDD.WWWWWW..DDDD.',
  '..DDDDDWWKKWW.DDDDD.',
  '..DDDDDWWWWWW.DDDDD.',
  '..DDDDD.WOOOW.DDDDD.',
  '...DDDDBOOOOBDDDD...',
  '....DDDBBBBBBDDDD...',
  '.....DDBBBBBBDDDD...',
  '......DBBBBBBDDDD...',
  '.......BBBBBBDDD....',
  '........BBBBDDD.....',
  '.........BBBBD......',
  '.........BWWWB......',
  '.........WWWWW......',
  '........WWWWWWW.....',
  '.........W...W......',
  '.........W...W......',
];
const EAGLE_COLORS = { D:'#6E3A12', B:'#B5762C', W:'#FFF8E7', K:'#16181C', O:'#FF9E00' };
/* 像素老鹰的实际绘制（供精灵烘焙共用）：把 EAGLE_PIX 的字母逐像素铺格 */
function paintEagleArt(ox, oy, S){
  for (let r = 0; r < 20; r++){
    const row = EAGLE_PIX[r];
    for (let c = 0; c < 20; c++){
      const ch = row[c];
      if (ch === '.') continue;
      ctx.fillStyle = EAGLE_COLORS[ch];
      ctx.fillRect(ox + c*S, oy + r*S, S, S);
    }
  }
}
function drawEagle(x, y){
  // 脉动金色光晕：随 gameTime 变化，保持每帧绘制
  const pulse = 0.5 + 0.5 * Math.sin(gameTime * 3);
  ctx.fillStyle = 'rgba(255,195,0,' + (0.10 + pulse * 0.16).toFixed(3) + ')';
  ctx.fillRect(x - 2, y - 2, 44, 44);
  // 金色底座 + 像素老鹰：一次 drawImage 取代原先每帧最多 400 次 fillRect
  initEagleSprite();
  if (eagleSprite) ctx.drawImage(eagleSprite, x, y, 40, 40);
  else {
    px(x, y, 40, 40, '#8A5A00');
    px(x + 2, y + 2, 36, 36, '#FFC300');
    px(x + 4, y + 4, 32, 32, '#FFDB4D');
    px(x + 4, y + 4, 32, 2, '#FFEEA0');
    paintEagleArt(x, y, 2);
  }
}
/* 老鹰道具图标：复用基地老鹰像素图，1:1 铺满一个格子（同样烘焙成精灵） */
function drawEagleItem(x, y){
  if (!eagleItemSprite) eagleItemSprite = makeSprite(20, 20, () => paintEagleArt(0, 0, 1));
  if (eagleItemSprite) ctx.drawImage(eagleItemSprite, x, y, 20, 20);
  else paintEagleArt(x, y, 1);
}
function drawBaseBroken(x, y){
  px(x+3, y+3, 34, 34, '#3A3F45');
  px(x+8, y+8, 24, 24, '#1E2126');
  px(x+13, y+13, 14, 14, '#FF3B30');
  px(x+16, y+16, 8, 8, '#FF8A00');
}

/* ================= 渲染：坦克（高清重绘） ================= */
function tankColors(t){
  if (t.isPlayer) return { body:'#F5C518', dark:'#8A6200', light:'#FFE987', track:'#4A4F57', trackLight:'#A9B4C0' };
  if (t.kind === 'bonus'){
    const blink = flashOn(6);
    return blink ? { body:'#FF3B30', dark:'#7E120C', light:'#FF9A92', track:'#5A1E19', trackLight:'#C96A62' }
                 : { body:'#FFE8E6', dark:'#B0554D', light:'#FFFFFF', track:'#6B3A34', trackLight:'#D9A9A3' };
  }
  const d = ETYPES[t.kind];
  return { body:d.body, dark:d.dark, light:'#FFFFFF', track:'#3A3F45', trackLight:'#767E88' };
}
/* 敌人拾取手雷后的红色警示圈：闪烁 + 引信倒计时，给玩家跑开的机会 */
function drawGrenadeWarn(){
  for (const g of grenadeBlasts){
    const on = flashOn(8);
    ctx.save();
    ctx.fillStyle = on ? 'rgba(255,59,48,0.18)' : 'rgba(255,210,63,0.10)';
    ctx.beginPath(); ctx.arc(g.px, g.py, g.r, 0, 7); ctx.fill();
    ctx.strokeStyle = on ? '#FF3B30' : '#FFD23F';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(g.px, g.py, g.r, 0, 7); ctx.stroke();
    if (on){
      ctx.fillStyle = '#FF3B30';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('!', g.px, g.py - g.r + 14);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }
}

/* 受击白闪：满屏爆炸时给一个明确的「打中了」确认 */
function hitFlashRect(cx, cy, left){
  ctx.save();
  ctx.globalAlpha = 0.55 * Math.max(0, Math.min(1, (left || 0) / 0.12));
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(cx - 11, cy - 14, 22, 28);
  ctx.restore();
}

/* 血条：仅受伤后显示（armor 常驻，因为「硬」是核心信号）；
 * maxHp>=4 时按血格分段，与 1 点伤害的离散模型吻合。 */
function drawHealthBar(t, cx, cy){
  // 兵种点带占 cy+14~cy+19，血条在其上方，两条标记带不会相交
  if (t.maxHp <= 1) return;
  if (t.hp >= t.maxHp && t.kind !== 'armor' && t.kind !== 'boss') return;   // 首领血条常显
  const w = t.kind === 'boss' ? 32 : 16, h = 2, x = cx - w/2, y = cy - 21;
  px(x - 1, y - 1, w + 2, h + 2, '#0B0D10');
  px(x, y, w, h, '#14171B');
  const ratio = Math.max(0, t.hp / t.maxHp);
  const low = ratio < 0.3;
  const blink = low && flashOn(6);
  let col = ratio > 0.6 ? '#46B455' : ratio >= 0.3 ? '#FFD23F' : '#FF3B30';
  if (blink) col = '#FFFFFF';
  if (t.maxHp >= 4){
    const seg = w / t.maxHp;
    for (let i = 0; i < t.hp; i++) px(x + i*seg, y, seg - 1, h, col);
  } else {
    px(x, y, Math.max(1, w * ratio), h, col);
  }
  if (low){   // 濒死：1px 红描边
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.strokeRect(x - 2.5, y - 2.5, w + 5, h + 5);
  }
}

/* ---- 兵种识别标记（色盲友好） ----
 * 实测：6 张坦克贴图的 alpha 轮廓完全一致（各 640 个不透明像素，逐对像素差 0.0%），
 * 也就是说「普通/快速/火力/装甲」只靠颜色区分——红绿色盲或屏幕偏色时无法分辨。
 * 这里在坦克下方用「点数」冗余编码兵种（形状/数量承载信息，不依赖颜色）：
 *   1 点 = 快速兵   2 点 = 火力兵   3 点 = 装甲兵
 * 普通兵无点；道具兵已有 ★；首领已有皇冠——四类标记互斥，不会堆在一起。
 * 用中性亮色 + 深色底托，保证在雪地/沙漠等亮地形上同样可读。 */
const KIND_PIPS = { fast: 1, power: 2, armor: 3 };
const PIP_SIZE = 3, PIP_GAP = 2;
const KIND_PIP_Y = 15;    // 点带在坦克下方（精灵底边约 cy+13.5）
const AMPHIB_Y   = 22;    // 两栖标记带，位于点带之下（点带占 14~19）
function drawKindPips(t, cx, cy){
  const n = KIND_PIPS[t.kind];
  if (!n) return;
  const total = n * PIP_SIZE + (n - 1) * PIP_GAP;
  const x0 = cx - total / 2, y = cy + KIND_PIP_Y;
  px(x0 - 1, y - 1, total + 2, PIP_SIZE + 2, '#0B0D10');   // 深色底托 → 亮地形上也有对比
  for (let i = 0; i < n; i++) px(x0 + i * (PIP_SIZE + PIP_GAP), y, PIP_SIZE, PIP_SIZE, '#EDEFF2');
}

function drawTank(t){
  if (t.dead) return;
  // 无敌闪烁：减少动效时不隐身（10Hz 闪烁不合规），改由护盾光环标识
  if (t.invuln > 0 && !reduceMotion && Math.floor(gameTime*10) % 2 === 0) return;
  const c = tankColors(t);
  const cx = Math.round(t.px), cy = Math.round(t.py);
  // 护盾光环（减少动效时，短时无敌也画环，替代闪烁提示）
  if (t.invuln > 2.5 || (reduceMotion && t.invuln > 0)){
    ctx.strokeStyle = 'rgba(127,208,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 13, 0, 7); ctx.stroke();
  }
  // 像素贴图（素材 28x36，炮管朝上，中心对齐格心；等比缩放到 21x27，履带宽≈20 与格子对齐）
  const trec = IMG['tank_' + t.kind] || (t.isPlayer ? IMG.tank_player : null);
  // 受击白闪与道具敌人白闪在「减少动效」下关闭（改用静态标记 + 血条反馈）
  const flash = !reduceMotion && (t.hitFlash > 0 || (t.kind === 'bonus' && flashOn(6)));
  if (trec && trec.ok){
    const useFlash = flash && trec.flashEl;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t.dir * Math.PI / 2);
    ctx.drawImage(useFlash ? trec.flashEl : trec.el, -10.5, -13.5, 21, 27);
    ctx.restore();
    if (flash && !trec.flashEl) hitFlashRect(cx, cy, t.hitFlash);
  } else {
  // —— 矢量绘制（素材缺失时的回退，保持原观感）——
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t.dir * Math.PI / 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#0B0D10';

  // 炮管（先画，位于车体下方）
  ctx.fillStyle = c.dark;
  ctx.fillRect(-2, -13, 4, 9);
  ctx.strokeRect(-2.5, -13.5, 5, 10);
  ctx.fillStyle = c.light;
  ctx.fillRect(-2, -12, 1, 8);
  // 炮口
  ctx.fillStyle = c.dark;
  ctx.fillRect(-3, -15, 6, 3);
  ctx.strokeRect(-3.5, -15.5, 7, 4);

  // 履带
  ctx.fillStyle = c.track;
  ctx.fillRect(-10, -9, 5, 19);
  ctx.fillRect(5, -9, 5, 19);
  ctx.strokeRect(-10.5, -9.5, 6, 20);
  ctx.strokeRect(4.5, -9.5, 6, 20);
  ctx.fillStyle = c.trackLight;
  for (let i = 0; i < 6; i++){
    const yy = -8 + i * 3.2;
    ctx.fillRect(-10, yy, 5, 1.4);
    ctx.fillRect(5, yy, 5, 1.4);
  }

  // 车体
  ctx.fillStyle = c.body;
  ctx.fillRect(-5, -8, 10, 17);
  ctx.strokeRect(-5.5, -8.5, 11, 18);
  // 前装甲斜板
  ctx.fillStyle = c.light;
  ctx.fillRect(-5, -8, 10, 2.5);
  // 侧面阴影
  ctx.fillStyle = c.dark;
  ctx.fillRect(-5, 6, 10, 3);
  ctx.fillRect(3, -6, 2, 12);
  // 车体高光
  ctx.fillStyle = c.light;
  ctx.fillRect(-4, -4, 1.5, 8);

  // 炮塔
  ctx.fillStyle = c.dark;
  ctx.beginPath(); ctx.arc(0, 0, 5.4, 0, 7); ctx.fill();
  ctx.strokeStyle = '#0B0D10';
  ctx.beginPath(); ctx.arc(0, 0, 5.4, 0, 7); ctx.stroke();
  ctx.fillStyle = c.body;
  ctx.beginPath(); ctx.arc(0, 0, 4.2, 0, 7); ctx.fill();
  ctx.fillStyle = c.light;
  ctx.beginPath(); ctx.arc(-1, -1, 1.8, 0, 7); ctx.fill();
  ctx.restore();
  }   // end 矢量回退
  if (flash && !(trec && trec.ok)) hitFlashRect(cx, cy, t.hitFlash);

  // 装甲血量（经典红点，与通用血条并存）
  if (t.kind === 'armor' && t.hp < t.maxHp){
    for (let i = 0; i < t.hp; i++) px(cx - 8 + i*5, cy - 16, 4, 3, '#C0392B');
  }
  // 减速：冰蓝覆盖 + 边缘冰晶
  if (t.slowT > 0){
    ctx.fillStyle = 'rgba(127,208,255,0.35)';
    ctx.beginPath(); ctx.arc(cx, cy, 10, 0, 7); ctx.fill();
  }
  if (freezeEnemies > 0 && !t.isPlayer){
    ctx.fillStyle = 'rgba(127,208,255,0.32)';
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, 7); ctx.fill();
  }
  // 血条 / 状态图标（自下而上：坦克 → 血条 → 状态 → 火力标记，互不遮挡）
  drawHealthBar(t, cx, cy);
  if (t.burnT > 0){
    px(cx - 2, cy - 25, 4, 3, flashOn(10) ? '#FFD23F' : '#FF6A00');
  }
  if (t.slowT > 0) px(cx - 2, cy - 25, 4, 3, '#BFE9FF');
  // 火力等级标注（敌我皆可见）
  if (t.power >= 2){
    for (let i = 0; i < t.power; i++) px(cx - 7 + i*5, cy - 30, 4, 4, GUN_COLORS[i] || '#FFD23F');
  }
  // 红色道具敌人标记（形状冗余：即使不闪也有 ★ 与红色区分）
  if (t.kind === 'bonus'){
    ctx.fillStyle = flashOn(6) ? '#FFFFFF' : '#FF3B30';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('★', cx, cy - 30);
    ctx.textAlign = 'left';
  }
  // BOSS 标记：紫色王冠 + 文字，与普通敌人一眼区分（形状冗余，不依赖颜色也能认）
  if (t.kind === 'boss'){
    ctx.fillStyle = '#B14BFF';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BOSS', cx, cy - 33);
    ctx.textAlign = 'left';
    px(cx - 9, cy - 31, 4, 3, '#B14BFF');
    px(cx - 2, cy - 31, 4, 3, '#B14BFF');
    px(cx + 5, cy - 31, 4, 3, '#B14BFF');
    px(cx - 9, cy - 33, 6, 2, '#D9A9FF');
    px(cx + 3, cy - 33, 6, 2, '#D9A9FF');
  }
  // 兵种识别标记（色盲友好）
  drawKindPips(t, cx, cy);
  // 水陆两栖标注（下移到兵种点下方，避免两条标记带叠在一起）
  if (t.amphibious > 0){
    px(cx - 6, cy + AMPHIB_Y, 12, 2, '#7FD0FF');
    px(cx - 4, cy + AMPHIB_Y + 2, 3, 2, '#7FD0FF');
    px(cx + 1, cy + AMPHIB_Y + 2, 3, 2, '#7FD0FF');
  }
}

/* ================= 渲染：道具 ================= */
function drawItem(it){
  const expiring = it.t > ITEM_LIFE - 6;
  // 临期闪烁：减少动效时改为常显 + 静态红描边（不闪烁）
  if (expiring && !reduceMotion && Math.floor(gameTime*8) % 2 === 0) return;
  const x = it.x*TILE, y = it.y*TILE, cx = x+10, cy = y+10;
  const ring = { star:'#F0C040', grenade:'#FF8A6B', shield:'#3FB7FF',
                 clock:'#E8EBEF', tank:'#FFD23F', amphibious:'#7FD0FF',
                 eagle:'#FFC300' }[it.type] || WEAPON_RING[it.type] || '#F0C040';
  // 呼吸外圈（减少动效时静止）
  const pulse = reduceMotion ? 0.5 : 0.5 + 0.5*Math.sin(gameTime*5);
  ctx.fillStyle = ring;
  ctx.globalAlpha = 0.25 + pulse*0.3;
  ctx.fillRect(x - 1, y - 1, TILE + 2, TILE + 2);
  ctx.globalAlpha = 1;
  if (expiring && reduceMotion){          // 临期静态提示（替代闪烁）
    ctx.strokeStyle = '#FF3B30'; ctx.lineWidth = 1;
    ctx.strokeRect(x - 1.5, y - 1.5, TILE + 3, TILE + 3);
  }
  /* 武器道具：直接用字母标识（F/C/L/S/H/T/D），比 20x20 的矢量小图标更易辨认 */
  const wLetter = WEAPON_LETTER[it.type];
  if (wLetter){
    ctx.save();
    px(x+1, y+1, TILE-2, TILE-2, ring);            // 主题色外框
    px(x+3, y+3, TILE-6, TILE-6, '#14171B');       // 深色内芯
    ctx.fillStyle = ring;
    ctx.font = 'bold 14px "Arial Black","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(wLetter, cx, cy + 1);
    ctx.restore();
    return;
  }
  // 像素贴图（素材自带主题色边框 + 图标，缩放铺满一个格子）；eagle 无素材走下方矢量绘制
  const irec = IMG['item_' + it.type];
  if (irec && irec.ok){
    ctx.drawImage(irec.el, x, y, TILE, TILE);
    return;
  }
  px(x+1, y+1, TILE-2, TILE-2, ring);
  px(x+4, y+4, TILE-8, TILE-8, '#14171B');
  switch(it.type){
    case 'star':
      ctx.fillStyle = '#F0C040';
      ctx.beginPath();
      ctx.moveTo(cx, cy-8); ctx.lineTo(cx+6, cy-3); ctx.lineTo(cx+8, cy); ctx.lineTo(cx+6, cy+3);
      ctx.lineTo(cx, cy+8); ctx.lineTo(cx-6, cy+3); ctx.lineTo(cx-8, cy); ctx.lineTo(cx-6, cy-3);
      ctx.closePath(); ctx.fill();
      px(cx-2, cy-2, 4, 4, '#FFEFA8');
      break;
    case 'grenade':
      ctx.fillStyle = '#3E4248';
      ctx.beginPath(); ctx.arc(cx, cy+2, 6, 0, 7); ctx.fill();
      px(cx-1, cy-7, 2, 3, '#98A2AD');
      px(cx-4, cy-3, 2, 2, '#FF8A6B');
      px(cx+2, cy, 3, 3, '#FF3B30');
      break;
    case 'shield':
      ctx.fillStyle = '#3FB7FF';
      ctx.beginPath();
      ctx.moveTo(cx, cy-8); ctx.lineTo(cx+7, cy-4);
      ctx.quadraticCurveTo(cx+7, cy+3, cx, cy+8);
      ctx.quadraticCurveTo(cx-7, cy+3, cx-7, cy-4);
      ctx.closePath(); ctx.fill();
      px(cx-2, cy-2, 4, 4, '#FFFFFF');
      break;
    case 'clock':
      ctx.fillStyle = '#E8EBEF';
      ctx.beginPath(); ctx.arc(cx, cy, 7.5, 0, 7); ctx.fill();
      px(cx-1, cy-6, 2, 6, '#14171B');
      px(cx, cy-1, 5, 2, '#14171B');
      px(cx-1, cy-1, 2, 2, '#3FB7FF');
      break;
    case 'tank':
      px(cx-7, cy-4, 14, 8, '#FFD23F');
      px(cx-7, cy-8, 4, 16, '#A87A00');
      px(cx+3, cy-8, 4, 16, '#A87A00');
      px(cx-2, cy-2, 4, 4, '#FFE88A');
      break;
    case 'amphibious':
      px(cx-7, cy-6, 14, 6, '#7FD0FF');
      px(cx-9, cy-2, 18, 4, '#3FB7FF');
      px(cx-7, cy, 14, 2, '#FFFFFF');
      px(cx-7, cy+3, 14, 2, '#FFFFFF');
      break;
    case 'eagle':
      drawEagleItem(x, y);
      break;
    default:
      if (WEAPON_RING[it.type]) drawWeaponIcon(it.type, x, y);
      break;
  }
}

/* 武器图标：20x20 纯矢量（无素材图，缺失素材的回退分支即走这里） */
function drawWeaponIcon(type, x, y){
  switch(type){
    case 'flame':   // 握把 + 三层火苗
      px(x+3, y+12, 3, 5, '#98A2AD');
      px(x+5, y+9, 4, 4, '#A9B4C0');
      px(x+8, y+11, 5, 3, '#FF3B30');
      px(x+9, y+8, 4, 4, '#FF8A00');
      px(x+10, y+6, 2, 3, '#FFD23F');
      px(x+14, y+4, 1, 1, '#FFD23F');
      break;
    case 'frost':   // 六角雪花
      px(x+9, y+4, 2, 12, '#FFFFFF');
      px(x+5, y+7, 10, 2, '#FFFFFF');
      px(x+6, y+5, 2, 2, '#BFE9FF'); px(x+12, y+13, 2, 2, '#BFE9FF');
      px(x+12, y+5, 2, 2, '#BFE9FF'); px(x+6, y+13, 2, 2, '#BFE9FF');
      px(x+8, y+8, 3, 3, '#3FB7FF');
      break;
    case 'laser':   // 枪体 + 贯穿光束
      px(x+3, y+9, 5, 4, '#A9B4C0');
      px(x+4, y+10, 3, 2, '#B14BFF');
      px(x+8, y+8, 11, 2, 'rgba(255,59,48,0.45)');
      px(x+8, y+9, 11, 1, '#FF3B30');
      break;
    case 'spread':  // 3 条扇形弹道
      px(x+3, y+9, 4, 3, '#A9B4C0');
      px(x+7, y+6, 4, 2, '#FFD23F');
      px(x+7, y+9, 5, 2, '#FFD23F');
      px(x+7, y+12, 4, 2, '#FFD23F');
      px(x+12, y+4, 2, 2, '#FFE88A'); px(x+13, y+9, 3, 2, '#FFE88A'); px(x+12, y+14, 2, 2, '#FFE88A');
      break;
    case 'homing':  // 弹头 + 弧线轨迹 + 准星
      px(x+3, y+4, 3, 3, '#46B455');
      px(x+6, y+6, 2, 2, '#46B455');
      px(x+8, y+8, 2, 2, '#46B455');
      px(x+10, y+11, 2, 2, '#46B455');
      px(x+11, y+12, 4, 1, '#FF3B30'); px(x+13, y+10, 1, 4, '#FF3B30');
      px(x+11, y+10, 5, 5, 'rgba(255,59,48,0)');
      ctx.strokeStyle = '#FF3B30'; ctx.lineWidth = 1;
      ctx.strokeRect(x+10.5, y+9.5, 6, 6);
      break;
    case 'tesla':   // 双电极 + 锯齿闪电
      px(x+2, y+8, 3, 4, '#A9B4C0'); px(x+15, y+8, 3, 4, '#A9B4C0');
      px(x+5, y+10, 3, 1, '#E8FBFF'); px(x+6, y+8, 2, 3, '#E8FBFF');
      px(x+8, y+7, 3, 1, '#E8FBFF'); px(x+10, y+9, 3, 1, '#E8FBFF');
      px(x+11, y+11, 3, 1, '#E8FBFF');
      px(x+8, y+6, 2, 1, '#4FD1E0'); px(x+11, y+13, 2, 1, '#4FD1E0');
      break;
    case 'drill':   // 螺旋钻头 + 速度线
      px(x+5, y+8, 4, 5, '#E8EBEF');
      px(x+9, y+9, 3, 3, '#C7CDD4');
      px(x+12, y+10, 2, 1, '#A9B4C0');
      px(x+2, y+7, 3, 1, '#A9B4C0'); px(x+2, y+12, 3, 1, '#A9B4C0');
      px(x+14, y+5, 2, 2, '#D9772E'); px(x+15, y+14, 2, 2, '#D9772E');
      break;
  }
}

function drawExplosion(ex){
  /* FC 出生四角星：前 2/3 时段闪烁，尺寸先放大后收拢 */
  if (ex.kind === 'spawn'){
    const p = ex.t / ex.dur;
    if (p < 0.75 && Math.floor(ex.t * 14) % 2 === 0){
      const r = 15 * (0.55 + 0.45 * Math.sin(p * Math.PI));
      ctx.save();
      ctx.translate(ex.px, ex.py);
      ctx.fillStyle = '#FFE88A';
      for (let k = 0; k < 2; k++){
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(0, -r); ctx.lineTo(r * 0.3, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.3, 0);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.22, 0, 7); ctx.fill();
      ctx.restore();
    }
    return;
  }
  const p = ex.t / ex.dur;
  const size = (ex.kind === 'big' ? 16 : ex.kind === 'spark' ? 5 : 9) * (0.4 + p * 1.6);
  ctx.save();
  ctx.globalAlpha = 1 - p * 0.85;
  ctx.translate(ex.px, ex.py);
  ctx.rotate(p * 3);
  px(-size, -size, size*2, size*2, '#FF7A00');
  px(-size*0.7, -size*0.7, size*1.4, size*1.4, '#FFD23F');
  px(-size*0.35, -size*0.35, size*0.7, size*0.7, '#FFF7E0');
  ctx.restore();
  ctx.globalAlpha = 1;
}

function render(){
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);   // 高分屏：统一缩放坐标系
  px(0, 0, PLAY_W, PLAY_H, '#000');
  flushTerrain();                                          // 地形缓存：无变化时零开销
  if (terrainCanvas) ctx.drawImage(terrainCanvas, 0, 0, PLAY_W, PLAY_H);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++){
    if (map[r][c] === WATER) drawWater(c*TILE, r*TILE);     // 水有波纹动画，不进缓存
  }
  for (const it of items) drawItem(it);
  if (player) drawTank(player);
  if (player2) drawTank(player2);
  for (const e of enemies) drawTank(e);
  /* 子弹：把「旋转矩阵」直接并入 setTransform，省掉每发的 save/translate/rotate/restore；
   * 弹体形状走预烘焙精灵（见 bulletSprite）。约 10 次绘制指令 → 2 次。 */
  for (const b of bullets){
    const p = b.power || 1;
    const sp = bulletSprite(b.gun, p);
    const ang = (b.ang == null ? angFor(b.dir) : b.ang) + Math.PI / 2;
    const co = Math.cos(ang), si = Math.sin(ang);
    ctx.setTransform(DPR*co, DPR*si, -DPR*si, DPR*co, DPR*b.px, DPR*b.py);
    if (sp) ctx.drawImage(sp, -BULLET_SPR_W/2, -BULLET_SPR_H/2, BULLET_SPR_W, BULLET_SPR_H);
    else paintBullet((GUNS[b.gun] || GUNS.normal).color, p, 0, 0);   // 回退：无 canvas 环境（变换已就位）
  }
  if (bullets.length) ctx.setTransform(DPR, 0, 0, DPR, 0, 0);   // 复位（后续绘制依赖基础变换）
  drawGrenadeWarn();
  for (const ex of explosions) drawExplosion(ex);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++){
    if (map[r][c] === TREE) drawTree(c*TILE, r*TILE);
  }
  if (baseAlive) drawEagle(12*TILE, 24*TILE);
  else drawBaseBroken(12*TILE, 24*TILE);
  if (!coarsePointer) drawPanel();   // 触屏：canvas 面板已被 CSS 裁掉，信息改由 DOM HUD 呈现
  if (levelIntro > 0 && state === 'playing') drawCurtain();
  if (state === 'playing' && hintT > 0) drawHint();
  if (state === 'title') drawTitle();
  else if (state === 'over') drawOver();
  else if (state === 'clear') drawClear();
  if (paused && state === 'playing') drawPause();
  if (!coarsePointer && (netMode !== 'off' || player2) && state === 'playing') drawCoopHud();
  syncHud();
}

/* 双人 HUD：左上角显示双方剩余生命与掉线状态 */
function drawCoopHud(){
  ctx.save();
  ctx.textAlign = 'left';
  ctx.font = 'bold 13px "Microsoft YaHei",sans-serif';
  ctx.fillStyle = '#F0C040';
  ctx.fillText('P1', 10, 20);
  for (let i = 0; i < Math.max(0, lives); i++){ px(34 + i*15, 9, 11, 11, '#FFD23F'); px(34+i*15, 13, 3, 6, '#A87A00'); }
  ctx.fillStyle = '#7FD0FF';
  ctx.fillText('P2', 10, 40);
  for (let i = 0; i < Math.max(0, lives2); i++){ px(34 + i*15, 29, 11, 11, '#7FD0FF'); px(34+i*15, 33, 3, 6, '#2F6F7E'); }
  if (coopDropped){ ctx.fillStyle = '#FF6B6B'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('（' + (netMode === 'host' ? '玩家2' : '房主') + '掉线，重连中…）', 10, 58); }
  else if (netMode === 'host' && coopRtt > 0){
    ctx.fillStyle = coopRtt > 150 ? '#FF8A6B' : '#98A2AD';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('延迟 ' + coopRtt + 'ms', 10, 58);
  }
  ctx.restore();
  // 玩家2 头顶标记，便于区分
  if (player2 && !player2.dead){
    ctx.save(); ctx.fillStyle = '#7FD0FF'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('2', player2.px, player2.py - 16); ctx.textAlign = 'left'; ctx.restore();
  }
}

/* 玩家生命图标：18x18 坦克剪影（履带 + 车体 + 炮塔 + 炮管）。
 * 关键：上一版用「黄方块+两根竖条」让部分用户看成「老鹰的脸」——
 * 而「老鹰」在本游戏中是基地的象征，用在玩家命槽会语义错乱。
 * 改用带炮塔/炮管的明确坦克轮廓，玩家槽 ↔ 坦克，基地 ↔ 老鹰。 */
function drawLifeIcon(x, y){
  // 左右履带（深灰）
  px(x+0,  y+5, 3, 9, '#4A4F57');
  px(x+15, y+5, 3, 9, '#4A4F57');
  // 履带内侧高光（让"履带"更像履带，不是"两条竖线"）
  px(x+3,  y+5, 1, 9, '#A9B4C0');
  px(x+14, y+5, 1, 9, '#A9B4C0');
  // 车体（玩家黄 + 顶面高光）
  px(x+3,  y+5, 12, 9, '#F5C518');
  px(x+3,  y+5, 12, 2, '#FFE987');
  // 炮塔（深棕，圆墩）
  px(x+7,  y+7, 4, 4, '#8A6200');
  // 炮管（朝上）
  px(x+8,  y+0, 2, 8, '#4A4F57');
}

/* ================= 面板 ================= */
function drawPanel(){
  const x0 = PLAY_W;
  px(x0, 0, PANEL_W, H, '#1A1D21');
  px(x0+1, 0, 2, H, '#30363D');
  ctx.fillStyle = '#F0C040';
  ctx.font = 'bold 20px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('坦克大战', x0+14, 34);
  ctx.fillStyle = '#A9B4C0';
  ctx.font = '11px sans-serif';
  ctx.fillText('TANK 1998', x0+14, 52);
  ctx.strokeStyle = '#30363D';
  ctx.beginPath(); ctx.moveTo(x0+10, 62); ctx.lineTo(x0+PANEL_W-10, 62); ctx.stroke();

  ctx.fillStyle = '#A9B4C0'; ctx.font = '12px sans-serif';
  ctx.fillText('得分 SCORE', x0+14, 88);
  ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(String(score).padStart(6,'0'), x0+14, 110);

  ctx.fillStyle = '#A9B4C0'; ctx.font = '12px sans-serif';
  ctx.fillText('最高 HI-SCORE', x0+14, 134);
  ctx.fillStyle = '#FF8A6B'; ctx.font = 'bold 16px sans-serif';
  ctx.fillText(String(hiScore).padStart(6,'0'), x0+14, 154);

  ctx.fillStyle = '#A9B4C0'; ctx.font = '12px sans-serif';
  ctx.fillText('生命 LIVES', x0+14, 178);
  for (let i = 0; i < Math.max(0, lives); i++){
    drawLifeIcon(x0+14+i*26, 186);
  }

  ctx.fillStyle = '#A9B4C0'; ctx.font = '12px sans-serif';
  ctx.fillText('敌余 ENEMY', x0+14, 228);
  const remain = remainEnemyCount();
  ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(String(remain).padStart(2,'0'), x0+14, 250);

  ctx.fillStyle = '#A9B4C0'; ctx.font = '12px sans-serif';
  ctx.fillText('关卡 LEVEL', x0+14, 274);
  ctx.fillStyle = '#7FD0FF'; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(String(level).padStart(2,'0'), x0+14, 296);
  // 档位标签：新兵/老兵/精锐/王牌/噩梦，且标注精英关与 BOSS 关
  ctx.fillStyle = isBossLevel() ? '#B14BFF' : (isEliteLevel() ? '#FF8A6B' : '#A9B4C0');
  ctx.font = 'bold 11px "Microsoft YaHei",sans-serif';
  ctx.fillText(levelTag(), x0+44, 296);

  ctx.fillStyle = '#A9B4C0'; ctx.font = '12px sans-serif';
  ctx.fillText('火力 FIRE', x0+14, 320);
  for (let lv = 1; lv <= 3; lv++){
    const gy = 330 + (lv-1)*24;
    const active = player && player.power >= lv;
    const bw = 2 + lv;
    px(x0+14, gy-1, bw+6, 7, active ? GUN_COLORS[lv-1] : '#3A3F45');
    ctx.fillStyle = active ? '#FFFFFF' : '#7E8792';
    ctx.font = '11px sans-serif';
    ctx.fillText('Lv'+lv+' '+GUN_NAMES[lv-1], x0+14+bw+12, gy+4);
  }

  // 武器（常驻，位于火力下方）
  const wpn = (player && player.gun) || 'normal';
  const wg = GUNS[wpn] || GUNS.normal;
  ctx.fillStyle = '#A9B4C0'; ctx.font = '12px sans-serif';
  ctx.fillText('武器 WEAPON', x0+14, 398);
  if (wpn !== 'normal'){
    px(x0+14, 404, 12, 12, wg.color);
    ctx.fillStyle = '#14171B'; ctx.font = 'bold 10px "Arial Black",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(WEAPON_LETTER[wpn] || '?', x0+20, 413);
    ctx.textAlign = 'left';
    ctx.fillStyle = wg.color; ctx.font = 'bold 12px sans-serif';
    ctx.fillText(wg.name, x0+31, 414);
    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 12px sans-serif';
    ctx.fillText('×' + player.ammo, x0+96, 414);
  } else {
    ctx.fillStyle = '#7E8792'; ctx.font = '12px sans-serif';
    ctx.fillText('— 普通弹', x0+14, 414);
  }
  // 玩家血格（多血档位才画）
  if (player && !player.dead && player.maxHp > 1){
    for (let i = 0; i < player.maxHp; i++){
      px(x0+118 + i*12, 405, 10, 10, i < player.hp ? '#46B455' : '#3A3F45');
    }
  }

  // 红色道具敌人剩余
  let bonusLeft = 0;
  for (const k of enemyQueue) if (k === 'bonus') bonusLeft++;
  for (const e of enemies) if (!e.dead && e.kind === 'bonus') bonusLeft++;
  ctx.fillStyle = '#FF6B6B'; ctx.font = 'bold 11px sans-serif';
  ctx.fillText('★ 道具敌 x' + bonusLeft + '（击杀必掉）', x0+14, 434);

  ctx.strokeStyle = '#30363D';
  ctx.beginPath(); ctx.moveTo(x0+10, 446); ctx.lineTo(x0+PANEL_W-10, 446); ctx.stroke();
  ctx.fillStyle = '#98A2AD'; ctx.font = '11px sans-serif';
  ctx.fillText('↑↓←→/WASD · 空格射击', x0+14, 464);
  ctx.fillText('P 暂停  M 静音  H 血量', x0+14, 480);

  /* 状态区：双列紧凑，3 行容纳 6 个状态，避免溢出画布 */
  let ny = 484, nx = x0 + 14;
  ctx.font = 'bold 11px sans-serif';
  const st = (txt, col) => {
    ctx.fillStyle = col; ctx.fillText(txt, nx, ny);
    if (nx === x0 + 14) nx = x0 + 88; else { nx = x0 + 14; ny += 15; }
  };
  if (freezeEnemies > 0) st('冻敌 ' + freezeEnemies.toFixed(1), '#7FD0FF');
  if (freezePlayer > 0) st('冻我 ' + freezePlayer.toFixed(1), '#FF8A6B');
  if (player && playerEagle > 0) st('老鹰 ' + playerEagle.toFixed(1), '#FFC300');
  else if (player && player.invuln > 2.5) st('护盾 ' + player.invuln.toFixed(1), '#7FD0FF');
  if (player && player.amphibious > 0) st('两栖 ' + player.amphibious.toFixed(1), '#7FD0FF');
  if (player && player.burnT > 0) st('燃烧 ' + player.burnT.toFixed(1), '#FF6A00');
  if (player && player.slowT > 0) st('减速 ' + player.slowT.toFixed(1), '#BFE9FF');
  if (player && player.overheatT > 0) st('过热 ' + player.overheatT.toFixed(1), '#FF8A00');
  /* 音频被浏览器挂起时的可见提示（点一下屏幕即可恢复） */
  if (!muted && audioBlocked()){
    ctx.fillStyle = '#98A2AD'; ctx.font = '11px sans-serif';
    ctx.fillText('♪ 点按开启音效', x0+14, 514);
  }
}

/* ================= 手机端 DOM HUD =================
 * 触屏设备上 canvas 面板被 CSS 裁掉，核心信息改由此处渲染：
 * 字号固定 13~14px（不随画布等比缩小），小屏可读；桌面端 #hud 为 display:none。 */
const hudEl     = document.getElementById('hud');
const hudScore  = document.getElementById('hud-score');
const hudLives  = document.getElementById('hud-lives');
const hudLives2 = document.getElementById('hud-lives2');
const hudLevel  = document.getElementById('hud-level');
const hudPower  = document.getElementById('hud-power');
const hudEnemy  = document.getElementById('hud-enemy');
const hudWeapon = document.getElementById('hud-weapon');
const _hudCache = Object.create(null);
function hearts(n){                       // 避免依赖 String.prototype.repeat
  let s = ''; for (let i = 0; i < n; i++) s += '♥'; return s || '—';
}
function setHud(node, val){
  if (!node) return;
  if (_hudCache[node.id] === val) return;  // 只有变化时才写 DOM，避免每帧重排
  _hudCache[node.id] = val;
  node.textContent = val;
}
function syncHud(){
  if (!hudEl || !hudEl.classList) return;
  const remain = remainEnemyCount();
  setHud(hudScore,  String(score).padStart(6, '0'));
  setHud(hudLives,  lives  > 0 ? hearts(lives)  : '—');
  setHud(hudLives2, lives2 > 0 ? hearts(lives2) : '—');
  setHud(hudLevel,  String(level).padStart(2, '0') + (isBossLevel() ? '·BOSS' : (isEliteLevel() ? '·精英' : '')));
  setHud(hudPower,  'Lv' + ((player && player.power) || 1));
  const hw = (player && player.gun) || 'normal';
  setHud(hudWeapon, hw === 'normal' ? '—' : ((WEAPON_LETTER[hw] || '?') + ' ' + (GUNS[hw] || {}).name + ' ×' + player.ammo));
  setHud(hudEnemy,  String(remain).padStart(2, '0'));
  hudEl.classList.toggle('coop', netMode !== 'off' || !!player2);
}

function overlayText(lines, big){
  px(0, 0, PLAY_W, PLAY_H, 'rgba(0,0,0,0.72)');
  ctx.textAlign = 'center';
  /* 逐行累加 y：gap 表示「本行到下一行」的间距。
   * 旧写法 190 + i*gap 会让 gap 较小的后一行反向上移，出现行与行重叠（GAME OVER 的得分被提示覆盖）。 */
  let y = 190;
  lines.forEach(ln => {
    ctx.fillStyle = ln.color || '#FFFFFF';
    ctx.font = ln.size || '26px "Microsoft YaHei",sans-serif';
    ctx.fillText(ln.text, PLAY_W/2, y);
    y += (ln.gap || 46);
  });
  ctx.textAlign = 'left';
}
function drawTitle(){
  overlayText([
    { text:'坦 克 大 战', size:'bold 54px "Microsoft YaHei",sans-serif', color:'#F0C040', gap:70 },
    { text:'TANK 1998 · 增强版', size:'18px sans-serif', color:'#A9B4C0', gap:30 },
    { text:'保卫基地，消灭所有敌军', size:'16px sans-serif', color:'#C9D1D9', gap:40 },
    { text:'红色闪烁敌人击杀必掉道具', size:'15px sans-serif', color:'#FF6B6B', gap:26 },
    { text:'武器字母：F火焰 C冷冻 L激光 S散弹 H追踪 T电磁 D穿甲钻', size:'13px sans-serif', color:'#A9B4C0', gap:38 },
    { text:'初始 2 条命 · 每 2000 分奖一命 · Lv2/Lv3 火力可挡一次子弹', size:'13px sans-serif', color:'#98A2AD', gap:30 },
    { text:'点按屏幕 或 按 Enter 开始游戏', size:'20px sans-serif', color:'#7FD0FF', gap:40 },
    { text:'方向键/摇杆移动 · 空格/开火键射击', size:'13px sans-serif', color:'#98A2AD', gap:26 },
    { text:'H 键切换血量档位：' + PLAYER_HP_MODES.map((m, i) =>
        (i === hpMode ? '【' + m.label + ' ' + m.hp + '血】' : m.label + ' ' + m.hp + '血')).join('  '),
      size:'13px sans-serif', color:'#46B455', gap:28 },
  ]);
}
function drawOver(){
  overlayText([
    { text:'GAME OVER', size:'bold 52px sans-serif', color:'#FF5B5B', gap:80 },
    { text: overReason, size:'22px "Microsoft YaHei",sans-serif', color:'#F0C040', gap:50 },
    { text:'得分 ' + score, size:'20px sans-serif', color:'#FFFFFF', gap:44 },
    { text:'点按屏幕 或 按 Enter 重新开始', size:'16px sans-serif', color:'#7FD0FF', gap:30 },
  ]);
}
function drawClear(){
  overlayText([
    { text:'关卡 ' + level + ' 完成!', size:'bold 44px "Microsoft YaHei",sans-serif', color:'#F0C040', gap:70 },
    { text:'得分 ' + score, size:'20px sans-serif', color:'#FFFFFF', gap:50 },
    { text:'点按屏幕 或 按 Enter 进入下一关', size:'16px sans-serif', color:'#7FD0FF', gap:30 },
  ]);
}
/* 事件提示：敌军增援 / 手雷警示 / 获得武器 */
function drawHint(){
  ctx.save();
  ctx.globalAlpha = Math.min(1, hintT / 0.4);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(PLAY_W/2 - 110, 26, 220, 22);
  ctx.strokeStyle = '#F0C040'; ctx.lineWidth = 1;
  ctx.strokeRect(PLAY_W/2 - 110, 26, 220, 22);
  ctx.fillStyle = '#FFD23F';
  ctx.font = 'bold 13px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(hintMsg, PLAY_W/2, 42);
  ctx.textAlign = 'left';
  ctx.restore();
}
function drawPause(){
  px(0, 0, PLAY_W, PLAY_H, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 40px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('暂 停', PLAY_W/2, PLAY_H/2);
  ctx.textAlign = 'left';
}
/* FC 经典关卡开场：灰色幕布上下合拢 → 显示 STAGE N → 拉开 */
function drawCurtain(){
  const p = 1 - levelIntro / LEVEL_INTRO_TIME;   // 0 → 1
  let cover;
  if (p < 0.28)       cover = p / 0.28;                  // 合拢
  else if (p < 0.55)  cover = 1;                          // 停驻
  else                cover = 1 - (p - 0.55) / 0.45;      // 拉开
  cover = Math.max(0, Math.min(1, cover));
  const hh = (PLAY_H / 2) * cover;
  if (hh > 0){
    px(0, 0, PLAY_W, hh, '#6F6F6F');
    px(0, PLAY_H - hh, PLAY_W, hh, '#6F6F6F');
    px(0, hh - 3, PLAY_W, 3, '#3A3F45');
    px(0, PLAY_H - hh, PLAY_W, 3, '#3A3F45');
  }
  if (cover > 0.9){
    const boss = isBossLevel();
    ctx.textAlign = 'center';
    ctx.fillStyle = boss ? '#D9A9FF' : '#FFFFFF';
    ctx.font = 'bold 32px "Microsoft YaHei",sans-serif';
    ctx.fillText('STAGE ' + level, PLAY_W/2, PLAY_H/2 - 16);
    ctx.fillStyle = boss ? '#B14BFF' : '#F0C040';
    ctx.font = 'bold 16px "Microsoft YaHei",sans-serif';
    ctx.fillText(levelTag() + ' · 地貌 ' + levelThemeName, PLAY_W/2, PLAY_H/2 + 12);
    ctx.fillStyle = '#D9DDE3';
    ctx.font = '14px sans-serif';
    ctx.fillText('敌军 × ' + remainEnemyCount() + ' · 保卫基地', PLAY_W/2, PLAY_H/2 + 36);
    ctx.textAlign = 'left';
  }
}

/* ================= 双人合作：网络同步 =================
 * 快照瘦身（v1.2）：旧格式每 tick 都把整张地图 + 每个实体的完整字段名发一遍，
 * 20Hz 下约 8~15KB/s。新格式做了三件事：
 *   1) 地图改增量：首帧给全量，之后只发变化的格子（打砖 / 蒸水 / 基地被毁）
 *   2) 实体用「定长数组」代替对象，省掉每个实体重复的 key 名
 *   3) 附 seq 序号，客方在输入包里回带 ack，房主据此算出 RTT（用于显示延迟）
 * 收发两侧必须同步修改，数组下标即协议。 */
const TANK_F = ['id','x','y','px','py','dir','kind','hp','maxHp','fire','speed','power',
                'invuln','dead','deadTimer','score','isPlayer','ammo','gun','role',
                'pendingDir','movingTo','movingToY','amphibious','burnT','slowT','overheatT','hitFlash','bulletCd'];
function tankArr(t){                       // 下标见 TANK_F
  if (!t) return null;
  return [
    t.id, t.x, t.y, t.px, t.py, t.dir, t.kind, t.hp, t.maxHp, t.fire, t.speed, t.power,
    t.invuln, t.dead ? 1 : 0, t.deadTimer, t.score, t.isPlayer ? 1 : 0, t.ammo, t.gun, t.role,
    t.pendingDir === undefined ? -2 : t.pendingDir,
    t.movingTo ? t.movingTo.x : -1, t.movingTo ? t.movingTo.y : -1,
    t.amphibious, t.burnT, t.slowT, t.overheatT, t.hitFlash, t.bulletCd,
  ];
}
function arrTank(a){
  const t = {};
  for (let i = 0; i < TANK_F.length; i++) t[TANK_F[i]] = a[i];
  t.dead = !!t.dead;
  t.isPlayer = !!t.isPlayer;
  if (t.pendingDir === -2) t.pendingDir = null;
  t.movingTo = (t.movingTo >= 0 && t.movingToY >= 0) ? { x: t.movingTo, y: t.movingToY } : null;
  delete t.movingToY;
  return t;
}
function bulletArr(b){
  return [b.px, b.py, b.x, b.y, b.dir, b.ang, b.power || 1, b.gun || 'normal',
          (b.owner && b.owner.isPlayer) ? 1 : 0, b.kind];
}
function arrBullet(a){
  return { px:a[0], py:a[1], x:a[2], y:a[3], dir:a[4], ang:a[5], power:a[6], gun:a[7],
           owner:{ isPlayer: a[8] === 1 }, kind:a[9] };
}
/* 地图增量：setTile 写入，由 serializeSnapshot 取走；超过阈值就退回全量 */
let snapSeq = 0, coopRtt = 0, lastSnapT = 0;
/* 最近若干次快照的发送时刻（环形缓冲）：客方 ack 到达时往往已经发过更新的帧，
 * 所以不能只比对「最近一帧」，要在窗口内反查该 seq 的发送时间。 */
let snapPing = [];
const SNAP_PING_KEEP = 16;
function takeTileDelta(){
  const d = tileDelta;
  tileDelta = [];
  return d;
}
function serializeSnapshot(){
  const snap = {
    seq: ++snapSeq,
    s: state, lvl: level, score: score, lives: lives, lives2: lives2,
    fe: freezeEnemies, fp: freezePlayer, pe: playerEagle, li: levelIntro, base: baseAlive ? 1 : 0,
    p: tankArr(player),
    p2: tankArr(player2),
    e: enemies.filter(en => !en.dead).map(tankArr),
    b: bullets.map(bulletArr),
    it: items.filter(i => !i.dead).map(i => [i.x, i.y, i.px, i.py, i.type, i.t]),
    ex: explosions.map(x => [x.px, x.py, x.t, x.dur, x.kind]),
    gb: grenadeBlasts.map(g => [g.px, g.py, g.t, g.r]),
  };
  if (snapFullNeeded){
    snap.m = map.map(r => r.slice());     // 首帧（或换图/大面积破坏后）全量地图
    tileDelta = [];
    snapFullNeeded = false;
  } else {
    snap.md = takeTileDelta();            // 之后只发变化的格子
  }
  lastSnapT = performance.now();
  snapPing.push([snap.seq, lastSnapT]);
  while (snapPing.length > SNAP_PING_KEEP) snapPing.shift();
  return snap;
}
function applySnapshot(s){
  if (!s) return;
  state = s.s; level = s.lvl; score = s.score; lives = s.lives; lives2 = s.lives2;
  nextExtraLifeScore = (Math.floor(score / 2000) + 1) * 2000;
  freezeEnemies = s.fe; freezePlayer = s.fp; playerEagle = s.pe; levelIntro = s.li;
  baseAlive = (s.base === 1 || s.base === true);
  if (s.m){                               // 全量地图
    map = s.m.map(r => r.slice());
    terrainFull = true;
  }
  if (s.md){                              // 增量：只改变化的格子，并标记脏区
    for (const d of s.md){
      if (map[d[0]]) { map[d[0]][d[1]] = d[2]; markTileDirty(d[0], d[1]); }
    }
  }
  player = arrTank(s.p);
  player2 = s.p2 ? arrTank(s.p2) : null;
  enemies = s.e.map(arrTank);
  bullets = s.b.map(arrBullet);
  items = s.it.map(i => ({ x:i[0], y:i[1], px:i[2], py:i[3], type:i[4], t:i[5], dead:false }));
  explosions = s.ex.map(x => ({ px:x[0], py:x[1], t:x[2], dur:x[3], kind:x[4] }));
  grenadeBlasts = (s.gb || []).map(g => ({ px:g[0], py:g[1], t:g[2], r:g[3] }));
  if (typeof s.seq === 'number') applySnapshot.lastSeq = s.seq;
}
/* 客方：把已收到的最大 seq 回带在输入包里，房主据此算 RTT */
applySnapshot.lastSeq = 0;
/* 输入：客方把方向/开火压成 1 字节发给房主 */
function packInput(k){
  let b = 0;
  if (k.ArrowUp || k.KeyW) b |= 1;
  if (k.ArrowDown || k.KeyS) b |= 2;
  if (k.ArrowLeft || k.KeyA) b |= 4;
  if (k.ArrowRight || k.KeyD) b |= 8;
  if (k.Space || k.KeyJ) b |= 16;
  return b;
}
function unpackInput(b){
  return {
    ArrowUp: !!(b&1), ArrowDown: !!(b&2), ArrowLeft: !!(b&4), ArrowRight: !!(b&8),
    KeyW: !!(b&1), KeyS: !!(b&2), KeyA: !!(b&4), KeyD: !!(b&8),
    Space: !!(b&16), KeyJ: !!(b&16),
  };
}

/* ================= 双人合作：连接与 UI ================= */
function coopEl(id){ return document.getElementById(id); }
function coopSetStatus(msg){ const el = coopEl('coop-status'); if (el) el.textContent = msg || ''; }
function coopShowCode(code){ const el = coopEl('coop-code-display'); if (el) el.textContent = code ? ('房间号：' + code) : ''; }
function coopHideOverlay(){ const el = coopEl('coop-overlay'); if (el) el.classList.remove('show'); }

function coopHandleMsg(msg){
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'room' && msg.action === 'created'){
    coopRoomCode = msg.code; coopShowCode(msg.code);
    coopSetStatus('房间已创建，等待玩家2加入…');
  } else if (msg.type === 'room' && msg.action === 'joined'){
    coopSetStatus('已加入房间，等待房主开始…');
  } else if (msg.type === 'error'){
    if (msg.code === 'ROOM_NOT_FOUND') coopSetStatus('房间不存在，请检查房间号');
    else if (msg.code === 'ROOM_FULL') coopSetStatus('房间已满（仅支持 2 人）');
    else if (msg.code === 'ROOM_STARTED') coopSetStatus('房间已开始，无法加入');
    else coopSetStatus('连接错误：' + msg.code);
  } else if (msg.type === 'peer' && msg.event === 'joined'){
    if (netMode === 'host'){ coopDropped = false; coopSetStatus('玩家2已加入！'); coopHideOverlay(); if (state !== 'playing') startGame(); }
  } else if (msg.type === 'peer' && msg.event === 'dropped'){
    if (netMode === 'off') return;   // 主动关闭不视为掉线
    coopDropped = true;
    if (netMode === 'host') keys2 = {};   // 客方掉线：停止驱动玩家2，避免漂移
    coopSetStatus(netMode === 'host' ? '玩家2掉线，等待其重连…' : '房主掉线，等待其重连…');
  } else if (msg.type === 'peer' && msg.event === 'rejoined'){
    coopDropped = false;
    coopSetStatus(netMode === 'host' ? '玩家2已重连，继续！' : '房主已重连，继续！');
    // 房主立即补一帧快照，让回来的客方对齐到当前战局
    if (netMode === 'host' && typeof Net !== 'undefined') Net.send({ type:'state', snap: serializeSnapshot() });
    if (netMode === 'guest') coopReady = true;
  } else if (msg.type === 'peer' && msg.event === 'left'){
    coopDropped = false;
    coopSetStatus(netMode === 'host' ? '玩家2已离开' : '房主已离开');
  } else if (msg.type === 'net'){
    // 自身连接状态（由 net.js 的重连机制上报）
    if (msg.event === 'offline'){ coopDropped = true; coopSetStatus('连接断开，正在重连…'); }
    else if (msg.event === 'reconnecting'){ coopSetStatus('正在重连…（第 ' + msg.attempt + ' 次）'); }
    else if (msg.event === 'reconnected'){
      coopDropped = false;
      coopSetStatus(netMode === 'host' ? '已重连，等待玩家2回来…' : '已重连');
    } else if (msg.event === 'reconnect_failed'){
      coopDropped = true;
      coopSetStatus('重连失败，请重新创建或加入房间');
    }
  } else if (msg.type === 'state'){
    if (netMode === 'guest'){ applySnapshot(msg.snap); coopReady = true; coopHideOverlay(); }
  } else if (msg.type === 'input'){
    if (netMode === 'host'){
      keys2 = unpackInput(msg.k);
      // 客方回带 ack：在最近 16 帧的发送时刻里反查该 seq，得到往返时延（显示在双人 HUD 上）
      if (typeof msg.ack === 'number'){
        for (let i = snapPing.length - 1; i >= 0; i--){
          if (snapPing[i][0] === msg.ack){ coopRtt = Math.round(performance.now() - snapPing[i][1]); break; }
        }
      }
    }
  }
}

function coopReset(){
  netMode = 'off'; player2 = null; lives2 = 2; coopReady = false; coopDropped = false; coopRoomCode = '';
  keys2 = {};
  if (typeof Net !== 'undefined') Net.disconnect();
}

function coopInit(){
  if (typeof Net === 'undefined'){ console.warn('[coop] Net 模块未加载'); return; }
  Net.onOpen(() => {
    if (netMode === 'host') Net.send({ type:'room', action:'create' });
    else if (netMode === 'guest') Net.send({ type:'room', action:'join', code: coopRoomCode });
  });
  Net.onMessage(coopHandleMsg);

  const btnCoop = coopEl('btn-coop');
  const overlay = coopEl('coop-overlay');
  if (btnCoop && overlay){
    btnCoop.addEventListener('click', () => { initAudio(); overlay.classList.add('show'); coopRefreshLan(); coopRefreshRelay(); });
  }
  const btnClose = coopEl('btn-coop-close');
  if (btnClose) btnClose.addEventListener('click', () => {
    overlay.classList.remove('show'); coopReset(); coopSetStatus(''); coopShowCode('');
  });
  const btnCreate = coopEl('btn-create');
  if (btnCreate) btnCreate.addEventListener('click', () => {
    if (netMode !== 'off') coopReset();
    netMode = 'host'; coopSetStatus('连接中…'); coopShowCode(''); Net.connect('host');
  });
  const btnJoin = coopEl('btn-join');
  if (btnJoin) btnJoin.addEventListener('click', () => {
    const code = (coopEl('room-code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4){ coopSetStatus('请输入 4 位房间号'); return; }
    if (netMode !== 'off') coopReset();
    netMode = 'guest'; coopRoomCode = code; coopSetStatus('连接中…'); Net.connect('guest', code);
  });

  /* 中继地址（进阶）：页面托管在静态站点、游戏服务在另一台机器时使用。
   * 写入 localStorage，下次 connect() 生效；清空即恢复同源 /ws。 */
  const btnRelay = coopEl('btn-relay');
  if (btnRelay) btnRelay.addEventListener('click', () => {
    const raw = (coopEl('relay-url').value || '').trim();
    const applied = (typeof Net.setRelay === 'function') ? Net.setRelay(raw) : '';
    coopRefreshRelay();
    if (raw && !applied){ coopSetStatus('中继地址无效：需要 ws:// 或 wss:// 地址'); return; }
    coopSetStatus(raw ? ('中继已设为 ' + applied + '，下次连接生效') : '已恢复为同源中继');
  });
}

/* 显示当前生效的中继地址（自定义优先，否则同源 /ws） */
function coopRefreshRelay(){
  const el = coopEl('relay-now');
  if (!el) return;
  const now = (typeof Net !== 'undefined' && typeof Net.relayUrl === 'function') ? Net.relayUrl() : '';
  el.textContent = now || '同源';
}

function coopRefreshLan(){
  const el = coopEl('coop-lan');
  if (!el) return;
  el.textContent = '正在检测局域网地址…';
  const fallback = () => {
    el.textContent = (typeof location !== 'undefined' && location.host)
      ? (location.origin + '（静态托管：跨网请在下方填写中继地址）')
      : '（未检测到可用局域网 IP，请在系统设置中查看）';
  };
  getLanInfo().then(info => {
    // server 的 /lan 会带上实际端口与协议（含 HTTPS 部署），不再硬编码 8080
    if (info && info.url) el.textContent = info.url;
    else fallback();
  }).catch(fallback);
}

/* 局域网地址优先由 server 的 /lan 端点给出：
 * server 侧能读取本机所有网卡，过滤掉 169.254.x.x（APIPA）与虚拟网卡，
 * 这比浏览器 WebRTC ICE 更可靠，避免像 169.254.83.59 这种不可达地址。
 * 纯静态托管时没有该端点（404 或网络错误），调用方自行回退。 */
function getLanInfo(){
  return fetch('/lan')
    .then(r => r.ok ? r.json() : null)
    .then(j => (j && typeof j === 'object') ? j : null)
    .catch(() => null);
}

/* ================= 输入 ================= */
function setKey(code, val){
  // 双人客方：本地键盘/触屏控制玩家2（键位写入 keys2，由房主快照回显）
  if (netMode === 'guest') keys2[code] = val;
  else keys[code] = val;
}

/* 统一的“开始 / 重新开始 / 下一关”入口。
 * 键盘 Enter、点按画布、工具栏按钮三条路径共用，手机端无需键盘即可开局。 */
function requestStart(){
  if (netMode === 'guest') return;   // 客方不本地开局，等待房主快照
  if (state === 'playing') return;
  if (gameTime < startLockT) return;        // 结束/过关后的误触保护
  if (state === 'title' || state === 'over') startGame();
  else if (state === 'clear') nextLevel();
}

window.addEventListener('keydown', e => {
  initAudio();
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
  setKey(e.code, true);
  if (e.code === 'Enter') requestStart();
  if (e.code === 'KeyP') togglePause();
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyF') toggleFullscreen();
  if (e.code === 'KeyG') toggleFit();
  if (e.code === 'KeyE') debugDropEagle();
  if (e.code === 'KeyH' && state === 'title'){
    hpMode = (hpMode + 1) % PLAYER_HP_MODES.length;
    if (player){ player.maxHp = playerMaxHp(); player.hp = player.maxHp; }
    sfx.item();
  }
});
window.addEventListener('keyup', e => setKey(e.code, false));

/* 手机 / 触屏：点按画面即可开始、重开、进入下一关 */
canvas.addEventListener('pointerdown', e => {
  initAudio();
  if (state !== 'playing'){ e.preventDefault(); requestStart(); }
});

/* 触屏开火键（保留原 data-k 机制） */
document.querySelectorAll('.tbtn').forEach(btn => {
  const k = btn.dataset.k;
  const on  = e => { e.preventDefault(); initAudio(); setKey(k, true); };
  const off = e => { e.preventDefault(); setKey(k, false); };
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointerleave', off);
  btn.addEventListener('pointercancel', off);
});

/* 虚拟摇杆：左下角固定底盘，拖动杆头落定 上/下/左/右（4 向 snap，符合坦克网格移动） */
const joy = document.getElementById('joystick');
const joyKnob = document.getElementById('joy-knob');
function setJoyDir(dir){
  setKey('ArrowUp',   dir === 'up');
  setKey('ArrowDown', dir === 'down');
  setKey('ArrowLeft', dir === 'left');
  setKey('ArrowRight',dir === 'right');
}
function joyReset(){
  setJoyDir(null);
  if (joy) joy.classList.remove('active');
  if (joyKnob) joyKnob.style.transform = 'translate(-50%,-50%)';
}
if (joy && joyKnob){
  const DEAD = 14, RADIUS = 46;
  let joyId = null;
  function joyMove(clientX, clientY){
    const r = joy.getBoundingClientRect();
    let dx = clientX - (r.left + r.width / 2);
    let dy = clientY - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy) || 1;
    const cl = Math.min(dist, RADIUS);
    const nx = dx / dist, ny = dy / dist;
    joyKnob.style.transform = `translate(calc(-50% + ${nx * cl}px), calc(-50% + ${ny * cl}px))`;
    if (dist < DEAD){ setJoyDir(null); return; }
    if (Math.abs(dx) > Math.abs(dy)) setJoyDir(dx > 0 ? 'right' : 'left');
    else setJoyDir(dy > 0 ? 'down' : 'up');
  }
  joy.addEventListener('pointerdown', e => {
    e.preventDefault(); initAudio();
    joyId = e.pointerId; joy.setPointerCapture(e.pointerId);
    joy.classList.add('active'); joyMove(e.clientX, e.clientY);
  });
  joy.addEventListener('pointermove', e => {
    if (joyId !== null && e.pointerId === joyId) joyMove(e.clientX, e.clientY);
  });
  const joyEnd = e => {
    if (joyId !== null && e.pointerId === joyId){
      joyId = null;
      try { joy.releasePointerCapture(e.pointerId); } catch (_) {}
      joyReset();
    }
  };
  joy.addEventListener('pointerup', joyEnd);
  joy.addEventListener('pointercancel', joyEnd);
}

/* ================= 工具栏：全图 / 全屏 / 音效 / 暂停 ================= */
function toggleFit(){
  document.body.classList.toggle('fit');
  btnFit.classList.toggle('on', document.body.classList.contains('fit'));
}
function toggleFullscreen(){
  if (!document.fullscreenElement){
    const el = document.getElementById('wrap');
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } else if (document.exitFullscreen) document.exitFullscreen();
}
function toggleMute(){
  muted = !muted;
  btnMute.textContent = muted ? '🔇 静音' : '🔊 音效';
  btnMute.classList.toggle('on', muted);
  try { localStorage.setItem('tank1998_muted', muted ? '1' : '0'); } catch(e) {}   // 静音设置持久化
  applyVolumes();
}
function syncMuteBtn(){
  if (!btnMute) return;
  btnMute.textContent = muted ? '🔇 静音' : '🔊 音效';
  btnMute.classList.toggle('on', muted);
}

/* ---- 设置面板：主音量 / 音效 / 音乐（分项 + 持久化） ---- */
const setPanel   = document.getElementById('set-panel');
const volMaster  = document.getElementById('vol-master');
const volSfx     = document.getElementById('vol-sfx');
const volMusic   = document.getElementById('vol-music');
const chkBgm     = document.getElementById('chk-bgm');
const btnSet     = document.getElementById('btn-set');
function syncSetPanel(){
  if (volMaster) volMaster.value = String(Math.round(VOL.master * 100));
  if (volSfx)    volSfx.value    = String(Math.round(VOL.sfx * 100));
  if (volMusic)  volMusic.value  = String(Math.round(VOL.music * 100));
  if (chkBgm)    chkBgm.checked  = bgmOn;
}
function toggleSetPanel(){
  if (!setPanel) return;
  const show = !(setPanel.classList.contains('show'));
  setPanel.classList.toggle('show', show);
  if (btnSet) btnSet.classList.toggle('on', show);
  if (show) syncSetPanel();
}
if (btnSet) btnSet.addEventListener('click', toggleSetPanel);
if (volMaster) volMaster.addEventListener('input', e => { initAudio(); setVolume('master', e.target.value / 100); });
if (volSfx)    volSfx.addEventListener('input',    e => setVolume('sfx',    e.target.value / 100));
if (volMusic)  volMusic.addEventListener('input',  e => setVolume('music',  e.target.value / 100));
if (chkBgm)    chkBgm.addEventListener('change',   e => { initAudio(); setBgmOn(e.target.checked); });

/* ---- 图鉴：武器 / 道具 / 敌人 / 机制（覆盖层 + 分页切换） ---- */
const codexOverlay = document.getElementById('codex-overlay');
const btnCodex     = document.getElementById('btn-codex');
function showCodex(show){ if (!codexOverlay) return; codexOverlay.classList.toggle('show', show); if (btnCodex) btnCodex.classList.toggle('on', show); }
function codexSwitchTab(name){
  if (!codexOverlay || typeof codexOverlay.querySelectorAll !== 'function') return;
  codexOverlay.querySelectorAll('.codex-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === name));
  codexOverlay.querySelectorAll('.codex-pane').forEach(p => p.classList.toggle('active', p.getAttribute('data-pane') === name));
}
if (btnCodex) btnCodex.addEventListener('click', () => { initAudio(); showCodex(true); });
if (codexOverlay){
  const closeBtn = document.getElementById('btn-codex-close');
  if (closeBtn) closeBtn.addEventListener('click', () => showCodex(false));
  codexOverlay.addEventListener('click', e => { if (e.target === codexOverlay) showCodex(false); });
  if (typeof codexOverlay.querySelectorAll === 'function'){
    codexOverlay.querySelectorAll('.codex-tab').forEach(tab => {
      tab.addEventListener('click', () => codexSwitchTab(tab.getAttribute('data-tab')));
    });
  }
}
window.addEventListener('keydown', e => { if (e.key === 'Escape'){ showCodex(false); } });
function togglePause(){
  paused = !paused;
  btnPause.textContent = paused ? '▶ 继续' : '⏸ 暂停';
  btnPause.classList.toggle('on', paused);
}
function toggleReduceMotion(){ setReduceMotion(!reduceMotion); }
function syncReduceMotionBtn(){
  if (!btnFlash) return;
  btnFlash.textContent = reduceMotion ? '⚡ 闪烁：减弱' : '⚡ 闪烁：正常';
  btnFlash.classList.toggle('on', reduceMotion);
}
const btnFit   = document.getElementById('btn-fit');
const btnFs    = document.getElementById('btn-fs');
const btnMute  = document.getElementById('btn-mute');
const btnPause = document.getElementById('btn-pause');
const btnFlash = document.getElementById('btn-flash');
const btnStart = document.getElementById('btn-start');
btnFit.addEventListener('click', toggleFit);
btnFs.addEventListener('click', toggleFullscreen);
btnMute.addEventListener('click', toggleMute);
btnPause.addEventListener('click', togglePause);
if (btnFlash) btnFlash.addEventListener('click', toggleReduceMotion);
if (btnStart) btnStart.addEventListener('click', () => { initAudio(); requestStart(); });
syncReduceMotionBtn();
syncMuteBtn();        // 工具按钮就位后再同步（muted 已从 localStorage 恢复）
syncSetPanel();

/* 开始按钮文案随状态切换（手机端主要入口） */
let startBtnLabel = '';
function syncStartBtn(){
  if (!btnStart) return;
  const label = state === 'title' ? '▶ 开始游戏'
              : state === 'over'  ? '↻ 重新开始'
              : state === 'clear' ? '⏭ 下一关'
              : '▶ 游戏进行中';
  if (label !== startBtnLabel){ startBtnLabel = label; btnStart.textContent = label; }
  const dis = (state === 'playing');
  if (btnStart.disabled !== dis) btnStart.disabled = dis;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'playing' && !paused) togglePause();
});

/* ================= 主循环 ================= */
let last = performance.now();
function loop(now){
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (!paused){
    gameTime += dt;
    if (netMode !== 'guest') update(dt);   // 客方纯渲染，不模拟
    // 网络收发（20Hz）：房主发快照，客方发输入
    if (netMode !== 'off' && typeof Net !== 'undefined' && Net.isOpen()){
      netSendAcc += dt;
      if (netSendAcc >= 0.05){
        netSendAcc = 0;
        // 背压：上行积压时跳过一次快照，避免弱网下雪崩（输入包极小，永不跳过）
        if (netMode === 'host' && state === 'playing' && Net.bufferedAmount() < 262144){
          Net.send({ type:'state', snap: serializeSnapshot() });
        }
        else if (netMode === 'guest') Net.send({ type:'input', k: packInput(keys2), ack: applySnapshot.lastSeq });
      }
    }
  }
  render();
  syncBgm();          // 按状态切换背景音乐（无 AudioContext / 关掉音乐时为空操作）
  syncStartBtn();
  requestAnimationFrame(loop);
}

// 初始展示
map = buildMap();
player = makeTank(PLAYER_SPAWN.x, PLAYER_SPAWN.y, 0, 'player', {invuln:0, power:1});
coopInit();
requestAnimationFrame(loop);
