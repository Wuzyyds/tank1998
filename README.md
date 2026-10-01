# 坦克大战 1998 · 增强版

经典 FC 坦克大战的 HTML5 复刻增强版：单机闯关 + **双人合作**（同 WiFi / 房间号联机）。
原生 JavaScript，**零依赖、无构建**，一条 `node server.js` 即可开打。

## 特性

- 3 级火力、7 种武器（普通 / 火焰 / 冰霜 / 激光 / 电磁链 …），随机地形（砖 / 钢 / 水 / 草 / 沙漠 / 沼泽 / 雪地）
- **难度阶梯**：每 5 关一档（新兵 / 老兵 / 精锐 / 王牌 / 噩梦），敌人池、速度、血量、AI、总数整体抬升；每档第 4 关为**精英关**、第 5 关为 **BOSS 关**（首领高血高伤、必掉双道具）
- **关卡主题**：5 个档位对应 5 种地貌（草原 / 沙漠 / 雪原 / 沼泽 / 钢铁），地形配比不同，战术随之变化
- **武器字母标识**：地图上的武器道具直接显示字母（F 火焰 / C 冷冻 / L 激光 / S 散弹 / H 追踪 / T 电磁 / D 穿甲钻），面板与手机 HUD 同步显示
- BFS 距离场智能敌军、道具抢夺、手雷引信警示、老鹰基地无敌、道具敌人（击杀必掉）
- **双人合作闯关**：房主权威中继，P1/P2 各自独立命数，友伤天然关闭，断线自动重连
- 手机端左下角虚拟摇杆 + 右下角大号开火键；桌面键盘操作
- 手机端自动裁掉侧栏、游戏区放大到满宽，分数 / 命数 / 关卡 / 火力 / 武器改由 **DOM HUD** 呈现（字号不随画布缩小，小屏可读）
- 无障碍：跟随系统 `prefers-reduced-motion` + 工具栏「⚡ 闪烁」开关（满足 WCAG 2.3.1）；
  **兵种识别点数**（1/2/3 个白点 = 快速/火力/装甲，不依赖颜色区分，色盲可辨）
- 高分屏（DPR）适配（触屏封顶 2x / 桌面 3x）；**地形离屏缓存 + 脏区重绘**、
  **图块精灵化**（老鹰 / 树 / 水 / 子弹）——移动端每帧绘制指令数下降约 80%
- **程序化 chiptune 背景音乐**（标题 / 战斗两段循环，无额外素材）+ 主音量/音效/音乐三级总线，
  等响度曲线调节、总线限幅防爆音（敌我数十门炮同响也不削波）、设置持久化
- **公网可部署**：`server.js` 用 `--tls-cert/--tls-key` 直接提供 HTTPS + wss，
  带 `/healthz` 存活探测、WebSocket 保活 ping、可选 Origin 白名单；
  页面与中继分离时可用 `?relay=` 或面板填入独立中继地址
- PWA 可安装、离线可玩

## 快速开始

### 单机

直接用浏览器打开 `index.html` 即可，无需任何服务器。

### 双人 / 本地服务器

```bash
node server.js                                           # 默认 8080，明文 http + ws
node server.js --port 9000                               # 换端口
node server.js --tls-cert cert.pem --tls-key key.pem     # 公网：https + wss
node server.js --help                                    # 全部选项
```

浏览器打开 `http://<本机IP>:8080`。终端会打印本机、局域网与健康检查地址。

- **同一 WiFi**：把终端里「局域网」那一行地址发给好友（游戏内「👥 双人游戏」面板也会显示）
- **跨网络**：把端口部署/映射到公网，把地址发给好友
  - 页面会按自身协议自动选择：HTTPS 页面用 `wss://`，本机 http 用 `ws://`
  - 有域名和证书时推荐直接 `--tls-cert/--tls-key` 跑 HTTPS，不必再套一层代理
  - 页面与中继不在同一地址时（例如静态托管 + 独立中继），在双人面板的
    「中继地址」里填写 `wss://host:port/ws` 即可

### 操作

| 平台 | 移动 | 开火 | 其它 |
|---|---|---|---|
| 桌面 | 方向键 / WASD | 空格 / J | H 血量档位 · P 暂停 · M 静音 · Enter 开始 |
| 手机 | 左下摇杆 | 右下开火键 | 点按屏幕开始 / 过关 |

工具栏「⚙ 设置」可分别调节主音量 / 音效 / 音乐，并可关闭背景音乐（设置会记住）。

## 双人联机说明

1. 房主点「👥 双人游戏」→「创建房间」，把 4 位房间号发给好友
2. 好友点「👥 双人游戏」→ 输入房间号 →「加入房间」
3. 房主端「开始游戏」后即进入合作闯关

游戏逻辑**只在房主端运行**，客方只上传按键（20Hz，1 字节）并显示快照（20Hz），因此客方画面约有 0.05 秒延迟。
任一方断线后 20 秒内可**自动重连并恢复原角色**（凭重连令牌，防止被他人顶替）。

跨网络联机时双方打开同一个公网地址即可（HTTPS 部署会自动走 `wss://`）；
若中继与页面不同源（静态托管 + 独立中继），先在面板填好中继地址再建房。

快照做了瘦身：首帧发全量地图，之后**只发变化的格子**（打砖 / 蒸水 / 基地被毁），实体用定长数组编码，
并附 `seq` 序号由客方回带 `ack`——房主端会在画面左上角显示**实时延迟**，弱网时自动跳过积压的快照（背压保护）。

## 测试

```bash
npm test                    # 等价于下面两条
node tests/verify.js        # 单机逻辑 89 条断言（含渲染精灵化 / DPR 封顶 / 兵种点数 /
                            # 音频限幅与节流 等回归守卫）
node tests/net_test.js      # 中继协议 + 同步逻辑 + 断线重连 + 无障碍 + 高分屏 + DOM HUD
                            # + 地形缓存 + 难度/BOSS + 音量总线/BGM + 快照瘦身、
                            #   公网化（/healthz、缓存头、HEAD/405、保活 ping、Origin 白名单）、
                            #   中继地址解析、CLI/TLS 配置校验、顶层重名函数静态检查 108 条断言
```

均为无头测试（Node + vm 沙箱 + 真实子进程服务器），无需浏览器，也不依赖 openssl。

### 性能与平衡工具

```bash
node tools/profile.js       # 渲染剖析：每帧 canvas 绘制指令数 + JS 耗时 + 按函数归因
node tools/balance.js 20    # 受控压力测试：脚本 AI 代打前 20 关，输出难度曲线
```

两个工具都可复现、可在改动前后直接对比。`balance.js` 用固定随机种子，
并把基地设为不可毁、每关补满命数——它量的是**各档相对压力**，
不能替代真人试玩（详见文件头部说明）。

## 部署与上线

三种拓扑，按需要选：

| 玩法 | 需要什么 | 怎么做 |
|---|---|---|
| 单机（自己玩 / 发链接） | 任意静态托管 | 整个目录丢上去即可，入口是 `index.html`；可安装为 PWA 离线玩 |
| 双人 · 同 WiFi | 一台机器跑 `node server.js` | 把终端打印的「局域网」地址给好友 |
| 双人 · 跨公网 | 有公网 IP 的机器常驻 `node server.js` | 加 `--tls-cert/--tls-key` 直跑 HTTPS（或前面套 Caddy），放行防火墙端口 |

### 方案 A：单进程直跑 HTTPS（最简公网方案）

```bash
# 证书用 certbot / acme.sh / 云厂商签发的 fullchain.pem + privkey.pem
node server.js --port 443 --tls-cert fullchain.pem --tls-key privkey.pem
```

同一端口同时提供 `https://` 与 `wss://`，页面与中继同源，无需额外配置。
证书与私钥**必须同时提供**，只给一侧会直接报错退出——不会静默退回明文。

### 方案 B：明文跑服务 + Caddy/Nginx 终止 TLS

适合想用自动续期证书、或已有反代的场景。Caddy 会自动透传 WebSocket 升级：

```caddyfile
tank.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
node server.js --port 8080 --allow-origin https://tank.example.com
```

> `--allow-origin`（或 `ALLOW_ORIGIN`）只放行名单内的来源，避免公网中继被其它页面白嫖；留空则不校验。

### 方案 C：静态托管 + 独立中继

页面托管在 Netlify / Vercel / GitHub Pages（自带 HTTPS），中继跑在自己的机器上：

- 中继端：`node server.js --tls-cert ... --tls-key ...`
- 打开页面时带参数：`https://你的站点/?relay=wss://relay.example.com:9443/ws`
- 或在游戏内「👥 双人游戏 → 中继地址」填一次，之后会记住（`localStorage.tank1998_relay`）

### 常驻与守护

```ini
# /etc/systemd/system/tank1998.service
[Unit]
Description=TANK 1998 relay
After=network.target

[Service]
WorkingDirectory=/opt/tank1998
ExecStart=/usr/bin/node server.js --port 8080
Environment=ALLOW_ORIGIN=https://tank.example.com
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now tank1998
curl -fsS localhost:8080/healthz        # 存活探测，可接监控 / 负载均衡
```

不想用 systemd 也可以用 `pm2 start server.js -- --port 8080`。
服务收到 `SIGTERM`/`SIGINT` 会清理房间定时器后优雅退出，配合 `Restart=always` 滚动重启不残留僵尸连接。

### 上线检查清单

- [ ] `node --check game.js net.js server.js sw.js` 与 `npm test` 全绿
- [ ] `sw.js` 的 `VERSION` 和 `package.json` 版本号已提升（否则老用户拿不到新资源）
- [ ] 公网部署已启用 HTTPS/wss（浏览器会拒绝 HTTPS 页面连 `ws://`）
- [ ] 防火墙放行服务端口；云主机需同步放行安全组
- [ ] 公网场景设置了 `--allow-origin`
- [ ] `curl -fsS https://你的域名/healthz` 返回 `"ok":true`
- [ ] 两台设备实测：创建房间 → 加入 → 开局 → 断线重连
- [ ] 手机端实测：横屏、摇杆、开火键、DOM HUD 可读
- [ ] 补上 `LICENSE`（当前未附，公开发布前建议确定）

### PWA

`manifest.webmanifest` + `sw.js`。离线缓存为**网络优先、缓存回退**；发版时请提升 `sw.js` 里的 `VERSION` 以清理旧缓存。
由 `server.js` 托管时，入口 HTML / `sw.js` / 清单已强制 `no-cache`；**纯静态托管需自行配置等价策略**，否则用户会卡在旧版本。

## 无障碍

- 工具栏「⚡ 闪烁」按钮；首次进入默认跟随系统 `prefers-reduced-motion`
- 开启后：所有周期性闪烁限制到 **≤3Hz**（WCAG 2.3.1）、受击白闪关闭，无敌与道具临期改用**静态描边**提示
- 偏好保存在 `localStorage.tank1998_reduce_motion`

## 目录结构

```
index.html            页面骨架 + 触屏控件 + PWA 注册
style.css             样式（摇杆 / 开火键 / 弹窗 / 响应式 / 动效降级）
game.js               全部游戏逻辑（单机 + 双人同步）
net.js                浏览器 WebSocket 封装（指数退避重连 + 中继地址可配置）
server.js             零依赖中继服务器（静态托管 + /ws + 房间管理 + 可选 TLS/健康检查）
manifest.webmanifest  PWA 清单
sw.js                 Service Worker（离线缓存）
CHANGELOG.md          变更日志（Keep a Changelog）
assets/               图片 / 音频 / 内联音频兜底
tools/                资源生成脚本（音效 / 图标）+ 性能剖析 + 平衡压力测试
tests/                无头测试（Node）
```

## 已知限制

- 快照已做地图差分与实体数组化，但实体仍是「整份重发」（未按字段做差分）；跨网带宽仍有进一步压缩空间
- 客方无插值/预测，弱网下手感偏「跟手慢半拍」（房主端可看到实时延迟数值）
- 背景音乐为程序化生成的两段循环，尚未按关卡主题/紧张度切换
- 手机端只保留核心 HUD 字段；canvas 内的详细状态（护盾 / 冻敌 / 燃烧等计时）仍仅桌面可见
- 竖屏时游戏区受屏幕宽度限制，横屏或「⛶ 全图」体验更佳
- `game.js` 仍为单文件（约 3300 行），尚未拆分模块
- **难度曲线斜率不均**：压力测试显示「新兵→老兵→精锐」平缓（死亡/关 0.60 → 1.00 → 1.40），
  但「精锐→王牌」陡增约 2.9 倍（1.40 → 4.00）。待真人试玩确认后再调参
- 中继**不做鉴权与限流**：房间号是 4 位易读码，知道地址的人可以创建房间；
  适合朋友间对局，不适合承载敏感数据或大规模开放服务
- 未附 LICENSE，如需公开发布请自行选择并添加

## 版本

完整变更历史见 [CHANGELOG.md](CHANGELOG.md)。

- **1.4.0** — 发布准备：`server.js` 原生 TLS（https + wss）、`/healthz` 健康检查、
  WebSocket 保活 ping、可选 Origin 白名单、缓存策略与 HEAD/405、优雅关闭；
  `net.js` 中继地址可配置（`?relay=` / 面板输入），联机面板不再硬编码端口；
  新增 `CHANGELOG.md` 与上线检查清单

- **1.3.0** — 打磨轮：渲染精灵化（老鹰/树/水/子弹，绘制指令 −80%）、每帧无分配化、
  触屏 DPR 封顶；音频总线限幅 + 等响度曲线 + BGM 卡顿保护 + 音效节流；
  兵种识别点数（色盲）、触屏控件与页脚对比度修复；
  新增 `tools/profile.js`（性能剖析）与 `tools/balance.js`（平衡压力测试）

- **1.2.3** — 游戏内「图鉴」（武器 / 道具 / 敌人 / 机制四分页）

- **1.2.0** — 难度阶梯（每 5 关一档 + 精英关 + BOSS 关）、5 种关卡地貌主题、武器字母标识、
  地形离屏缓存与脏区重绘、程序化 BGM 与三级音量总线、双人快照瘦身（地图差分 + 实体数组化 + RTT 显示 + 背压）
- **1.1.0** — 断线自动重连、无障碍闪烁开关与 WCAG 合规、高分屏 DPR 适配、手机端 DOM HUD（裁面板放大游戏区）、PWA 离线与安装
- **1.0.0** — 双人合作闯关（同 WiFi / 房间号）、虚拟摇杆
