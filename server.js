/* =========================================================
 * TANK 1998 · 双人合作 —— 中继服务器（零依赖）
 * 同一端口既托管静态游戏文件，又提供 WebSocket 中继 (/ws)。
 *   - 同一 WiFi/局域网：两设备打开 http://<本机局域网IP>:<PORT>
 *   - 跨互联网（单进程）：加 --tls-cert/--tls-key 直接跑 https + wss
 *   - 跨互联网（反代）：明文跑本服务，前面套 Caddy/Nginx 终止 TLS
 *   - 房间号：4 位易读码，容量 2，纯中继（服务器不跑任何游戏逻辑）
 *
 * 运行：node server.js
 *   --port <n>            监听端口（默认 8080，也可用环境变量 PORT）
 *   --host <addr>         绑定地址（默认 0.0.0.0）
 *   --tls-cert <pem>      TLS 证书链；与 --tls-key 同时提供时启用 https/wss
 *   --tls-key  <pem>      TLS 私钥（可用 TLS_CERT / TLS_KEY 环境变量代替）
 *   --public-url <url>    对外访问地址，/lan 直接返回它（PUBLIC_URL 环境变量代替）
 *   --allow-origin <list> 逗号分隔的 Origin 白名单（防公网中继被盗用；留空不校验）
 *   --help                打印用法
 * ========================================================= */
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const RECONNECT_WINDOW = 20000;   // 掉线后保留房间与重连令牌的时长（毫秒）
const ROOM_CAP = 2;
const WS_PING_MS = Number(process.env.WS_PING_MS) || 30000;   // 保活 ping 间隔（可调，便于测试）

/* 取 --flag value 形式的命令行参数 */
function argValue(flag){
  const i = process.argv.indexOf(flag);
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : null;
}
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

const PORT = Number(process.env.PORT) || Number(argValue('--port')) || 8080;
const HOST = process.env.HOST || argValue('--host') || '0.0.0.0';
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || argValue('--allow-origin') || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const CERT_PATH = process.env.TLS_CERT || argValue('--tls-cert');
const KEY_PATH  = process.env.TLS_KEY  || argValue('--tls-key');
/* 对外访问地址（如 http://1.2.3.4 或 https://game.example.com）。
 * 公网部署时内网 IP 对访客毫无意义，设了它 /lan 就直接返回这个地址，
 * 联机面板里的「让好友打开 …」才显示得对。留空则保持局域网自动探测。 */
const PUBLIC_URL = (process.env.PUBLIC_URL || argValue('--public-url') || '').replace(/\/+$/, '');

if (HELP){
  console.log([
    'TANK 1998 双人服务器',
    '',
    '用法：node server.js [选项]',
    '',
    '  --port <n>            监听端口（默认 8080，也可用环境变量 PORT）',
    '  --host <addr>         绑定地址（默认 0.0.0.0）',
    '  --tls-cert <pem>      TLS 证书链，配合 --tls-key 启用 https + wss',
    '  --tls-key  <pem>      TLS 私钥（也可用 TLS_CERT / TLS_KEY 环境变量）',
    '  --public-url <url>    对外访问地址，/lan 直接返回它（也可用 PUBLIC_URL 环境变量）',
    '  --allow-origin <list> 逗号分隔 Origin 白名单，留空则不做校验',
    '  --help, -h            显示本帮助',
    '',
    '示例：',
    '  node server.js                                 局域网，明文 http',
    '  node server.js --port 9000                     换端口',
    '  node server.js --tls-cert cert.pem --tls-key key.pem   公网 https/wss',
    '  ALLOW_ORIGIN=https://game.example.com node server.js   限制可连中继的来源',
  ].join('\n'));
  process.exit(0);
}

let tlsOpts = null;
if (CERT_PATH || KEY_PATH){
  if (!(CERT_PATH && KEY_PATH)){
    console.error('[TLS] 证书与私钥必须同时提供：--tls-cert <cert.pem> --tls-key <key.pem>');
    process.exit(1);
  }
  try {
    tlsOpts = { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
  } catch (e) {
    console.error('[TLS] 读取证书/私钥失败：' + e.message);
    process.exit(1);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':  'image/gif',
  '.webp':  'image/webp',
  '.svg':  'image/svg+xml',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.json':  'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico':  'image/x-icon',
};

/* ============ 静态文件托管 ============ */
function safeJoin(root, urlPath){
  const p = path.normalize(path.join(root, urlPath.split('?')[0]));
  if (!p.startsWith(root)) return null;   // 防目录穿越
  return p;
}

const SCHEME = tlsOpts ? 'https' : 'http';
const WS_SCHEME = tlsOpts ? 'wss' : 'ws';
const WS_PATH = '/ws';
const startedAt = Date.now();
let wsCount = 0;                    // 当前 WebSocket 连接数（/healthz 用）

/* Service Worker 与入口 HTML 必须实时刷新（否则发版后用户卡在旧版本），
 * 其余静态资源给一小时缓存；sw.js 的缓存版本号负责清理旧资源。 */
function cacheControlFor(ext, base){
  if (base === 'sw.js' || ext === '.html' || ext === '.webmanifest') return 'no-cache';
  return 'public, max-age=3600';
}
/* 注意：本文件后面还有一个同名的 WebSocket 版发送函数（sendJson(sock,obj)）。
 * 函数声明会提升且后者覆盖前者，所以 HTTP 响应这条路径必须用独立名字，
 * 否则响应永远不会 end()，请求会一直挂着（曾经真实踩过这个坑）。 */
function sendJsonRes(res, obj, status){
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function handleRequest(req, res){
  if (req.method !== 'GET' && req.method !== 'HEAD'){
    res.writeHead(405, { 'Allow': 'GET, HEAD' }); res.end(); return;
  }
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('bad request'); return; }

  // 存活探测：供负载均衡 / systemd / 监控使用
  if (urlPath === '/healthz'){
    sendJsonRes(res, {
      ok: true, tls: !!tlsOpts, port: PORT,
      uptimeMs: Date.now() - startedAt,
      rooms: rooms.size, connections: wsCount,
    });
    return;
  }
  // 客户端获取推荐联机地址：优先 PUBLIC_URL（公网部署），否则自动探测局域网 IP
  if (urlPath === '/lan'){
    const lan = pickLanIP();
    sendJsonRes(res, {
      ip: lan.ip, port: PORT, tls: !!tlsOpts, public: !!PUBLIC_URL,
      url: PUBLIC_URL || (lan.ip ? (SCHEME + '://' + lan.ip + ':' + PORT) : null),
    });
    return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = safeJoin(ROOT, urlPath);
  if (!filePath){ res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err){ res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': cacheControlFor(ext, path.basename(filePath)),
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = tlsOpts
  ? https.createServer(tlsOpts, handleRequest)
  : http.createServer(handleRequest);

/* ============ 房间管理 ============ */
const rooms = new Map();   // code -> { host, guest, started, timer }
const CODE_ALPHABET = 'BCDEFGHJKMNPQRSTUVWXYZ';   // 剔除 I/L/O/0/1
const BAD_WORDS = ['SEX', 'FUK', 'XXX', 'KKK'];   // 脏话黑名单（粗略）
function genCode(){
  for (let attempt = 0; attempt < 200; attempt++){
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
    if (BAD_WORDS.includes(s)) continue;
    if (!rooms.has(s)) return s;
  }
  // 兜底：带数字后缀（极少走到）
  let s; do { s = (Math.random() * 9000 + 1000 | 0).toString(); } while (rooms.has(s));
  return s;
}
/* 重连令牌：角色被断线释放后，凭令牌在窗口内抢回原角色（防止他人顶替） */
function mkToken(){ return crypto.randomBytes(12).toString('base64url'); }
function newRoom(){
  return { host:null, guest:null, hostToken:null, guestToken:null,
           hostTimer:null, guestTimer:null, started:false, timer:null };
}
/* 角色槽位空置超过重连窗口后作废其令牌 */
function expireSlot(code, role){
  const room = rooms.get(code); if (!room) return;
  const key = role === 'host' ? 'hostTimer' : 'guestTimer';
  if (room[key]) clearTimeout(room[key]);
  room[key] = setTimeout(() => {
    if (role === 'host' && room.host === null) room.hostToken = null;
    else if (role === 'guest' && room.guest === null) room.guestToken = null;
  }, RECONNECT_WINDOW);
}
function sendJson(sock, obj){
  // 必须通过 WebSocket 帧发送（sendRaw），不能用裸 TCP sock.send，否则客户端无法解析
  if (sock && sock.readyState === 'open') sendRaw(sock, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}
function notifyPeer(room, exceptRole, msg){
  if (!room) return;
  if (room.host && room.host.role !== exceptRole) sendJson(room.host, msg);
  if (room.guest && room.guest.role !== exceptRole) sendJson(room.guest, msg);
}

/* ============ WebSocket：握手 + 帧 ============ */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptKey(key){
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}
server.on('upgrade', (req, socket) => {
  const url = req.url || '';
  if (url.split('?')[0] !== WS_PATH){ socket.destroy(); return; }
  // 公网部署时可限制来源，避免中继被第三方页面白嫖（非浏览器客户端不带 Origin，放行）
  if (ALLOW_ORIGIN.length){
    const origin = String(req.headers.origin || '');
    if (origin && ALLOW_ORIGIN.indexOf(origin) === -1){ socket.destroy(); return; }
  }
  const key = req.headers['sec-websocket-key'];
  if (!key){ socket.destroy(); return; }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + acceptKey(key),
    '\r\n',
  ];
  socket.write(headers.join('\r\n'));
  socket.setNoDelay(true);
  attachWs(socket);
});

/* 帧解析：客户端发来的帧是掩码的；只处理 text / close / ping / pong，
 * 支持分片（FIN=0 续帧）与 7/16/64 位长度。 */
function attachWs(socket){
  socket.role = null; socket.room = null; socket.buf = Buffer.alloc(0); socket.frags = [];
  socket._curOpcode = 0x1;
  wsCount++;
  /* 保活：定期发 ping 帧。浏览器会自动回 pong（RFC 6455 规定），
   * 既探测死连接，也避免反向代理 / NAT 把空闲长连接回收掉。 */
  socket._pingTimer = setInterval(() => {
    if (socket.destroyed || !socket.writable) return;
    try { sendRaw(socket, 0x9, Buffer.alloc(0)); } catch (e) {}
  }, WS_PING_MS);
  if (socket._pingTimer.unref) socket._pingTimer.unref();

  socket.on('data', chunk => {
    socket.buf = Buffer.concat([socket.buf, chunk]);
    let consumed = true;
    while (consumed){
      consumed = false;
      const buf = socket.buf;
      if (buf.length < 2) break;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126){ if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127){ if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let maskKey = null;
      if (masked){ if (buf.length < off + 4) break; maskKey = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) break;
      let payload = buf.slice(off, off + len);
      if (masked){
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      socket.buf = buf.slice(off + len);
      consumed = true;
      handleFrame(socket, fin, opcode, payload);
    }
  });

  socket.on('close', () => onSocketClose(socket));
  socket.on('error', () => onSocketClose(socket));
  socket.on('end', () => onSocketClose(socket));   // 客户端 FIN：半关闭也要触发掉线通知
}

function handleFrame(socket, fin, opcode, payload){
  if (opcode === 0x8){                                                  // close：回送关闭帧并结束
    try { sendRaw(socket, 0x8, Buffer.alloc(0)); } catch(e) {}
    try { socket.end(); } catch(e) {}
    return;
  }
  if (opcode === 0x9){                                                  // ping -> pong
    sendRaw(socket, 0xA, payload);
    return;
  }
  if (opcode === 0xA) return;                                          // pong
  if (opcode === 0x0) opcode = socket._curOpcode || 0x1;               // 续帧沿用本连接首帧 opcode
  else socket._curOpcode = opcode;
  if (opcode !== 0x1) return;                                          // 只处理 text
  if (fin) {
    try { dispatch(socket, JSON.parse(payload.toString('utf8'))); }
    catch(e) { /* 非法 JSON 忽略 */ }
    socket.frags = [];
  } else {
    socket.frags.push(payload);
  }
}

function sendRaw(socket, opcode, data){
  // 服务器发往客户端的帧不加掩码
  const len = data.length;
  let header;
  if (len < 126){ header = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536){ header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { socket.write(Buffer.concat([header, data])); } catch(e) {}
}
function sendJsonSocket(socket, obj){ sendRaw(socket, 0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }

function dispatch(socket, msg){
  if (!msg || typeof msg !== 'object') return;
  const type = msg.type;
  try {
    if (type === 'room' && msg.action === 'create'){
      const code = genCode();
      const room = newRoom();
      rooms.set(code, room);
      room.host = socket; room.hostToken = mkToken();
      socket.role = 'host'; socket.room = code;
      sendJsonSocket(socket, { type:'room', action:'created', code, token: room.hostToken });
    }
    else if (type === 'room' && msg.action === 'join'){
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room){ sendJsonSocket(socket, { type:'error', code:'ROOM_NOT_FOUND' }); return; }
      if (room.guest){ sendJsonSocket(socket, { type:'error', code:'ROOM_FULL' }); return; }
      if (room.started && room.host !== socket){ sendJsonSocket(socket, { type:'error', code:'ROOM_STARTED' }); return; }
      room.guest = socket; room.guestToken = mkToken();
      socket.role = 'guest'; socket.room = code;
      sendJsonSocket(socket, { type:'room', action:'joined', code, token: room.guestToken });
      notifyPeer(room, 'guest', { type:'peer', event:'joined' });   // 通知房主
    }
    else if (type === 'room' && msg.action === 'rejoin'){
      // 断线重连：凭令牌抢回空置的原角色，并通知另一方恢复
      const code = String(msg.code || '').toUpperCase();
      const token = String(msg.token || '');
      const room = rooms.get(code);
      if (!room || !token){ sendJsonSocket(socket, { type:'error', code:'ROOM_NOT_FOUND' }); return; }
      let role = null;
      if (!room.host && room.hostToken && token === room.hostToken) role = 'host';
      else if (!room.guest && room.guestToken && token === room.guestToken) role = 'guest';
      if (!role){ sendJsonSocket(socket, { type:'error', code:'REJOIN_FAILED' }); return; }
      if (role === 'host'){
        room.host = socket;
        if (room.hostTimer){ clearTimeout(room.hostTimer); room.hostTimer = null; }
      } else {
        room.guest = socket;
        if (room.guestTimer){ clearTimeout(room.guestTimer); room.guestTimer = null; }
      }
      socket.role = role; socket.room = code;
      sendJsonSocket(socket, { type:'room', action:'rejoined', code, role });
      notifyPeer(room, role, { type:'peer', event:'rejoined', role });
    }
    else if (type === 'room' && msg.action === 'leave'){
      leaveRoom(socket);
    }
    /* 纯中继：原样转发给房间内另一方，并打 from 标签。
     * 注意这里是**显式白名单**：新加的游戏消息类型必须同时登记在此，
     * 否则会在服务端被静默丢弃 —— 表现为「本机看着正常、联机完全无效」。
     * input/state 是每帧流；pause/start 是低频控制消息，走同一条通路。 */
    else if (type === 'input' || type === 'state' || type === 'pause' || type === 'start'){
      const room = socket.room ? rooms.get(socket.room) : null;
      if (!room) return;
      const out = Object.assign({}, msg, { from: socket.role });
      if (socket.role === 'host' && room.guest) sendJsonSocket(room.guest, out);
      else if (socket.role === 'guest' && room.host) sendJsonSocket(room.host, out);
    }
    else if (type === 'ping'){
      sendJsonSocket(socket, { type:'pong' });
    }
    else if (type === 'start'){
      // 房主标记房间已开始（用于阻止中途加入）
      const room = socket.room ? rooms.get(socket.room) : null;
      if (room && socket.role === 'host') room.started = true;
    }
  } catch(e) {}
}

function leaveRoom(socket){
  // 主动离开：立即作废令牌，不给重连机会
  const code = socket.room, role = socket.role;
  const room = code ? rooms.get(code) : null;
  if (room && role){
    notifyPeer(room, role, { type:'peer', event:'left', role });
    if (role === 'host'){
      room.host = null; room.hostToken = null;
      if (room.hostTimer){ clearTimeout(room.hostTimer); room.hostTimer = null; }
    } else {
      room.guest = null; room.guestToken = null;
      if (room.guestTimer){ clearTimeout(room.guestTimer); room.guestTimer = null; }
    }
    if (!room.host && !room.guest) scheduleDelete(code);
  }
  socket.role = null; socket.room = null;
}
function onSocketClose(socket){
  if (socket._closed) return;          // 防止 end/close/error 重复触发
  socket._closed = true;
  if (socket._pingTimer){ clearInterval(socket._pingTimer); socket._pingTimer = null; }
  wsCount = Math.max(0, wsCount - 1);
  const code = socket.room, role = socket.role;
  const room = code ? rooms.get(code) : null;
  if (room && role){
    notifyPeer(room, role, { type:'peer', event:'dropped', role });
    if (role === 'host') room.host = null; else room.guest = null;
    expireSlot(code, role);            // 保留令牌，等待其在窗口内重连
    if (!room.host && !room.guest) scheduleDelete(code);
  }
  socket.role = null; socket.room = null;
}
function scheduleDelete(code){
  const room = rooms.get(code);
  if (!room) return;
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (room.host === null && room.guest === null) rooms.delete(code);
  }, RECONNECT_WINDOW);
}

/* ============ 局域网 IP 选择：过滤 APIPA/虚拟网卡，优先私有网段 ============
 * 同一 WiFi 下应返回 192.168.x.x / 10.x.x.x / 172.16-31.x.x 等真实内网地址。
 * 169.254.x.x 是 APIPA（DHCP 失败），虚拟网卡（VMware/WSL/Docker/VPN）
 * 通常无实际局域网可达性，应跳过。 */
const VIRTUAL_NAME_RE = /vmware|hyper[-_]?v|virtual|veth|wsl|vmnet|vbox|tun|tap|hamachi|tailscale|zerotier|zt|cloudflare|warp|npcap|loopback|docker|ppp/i;
function isPrivateIPv4(ip){
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]), b = Number(parts[1]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
function isUnusableIPv4(ip){
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const a = Number(parts[0]), b = Number(parts[1]);
  if (a === 127) return true;          // loopback
  if (a === 169 && b === 254) return true; // APIPA / link-local
  return false;
}
function pickLanIP(){
  let all = [], best = null;
  try {
    const os = require('os');
    for (const [name, list] of Object.entries(os.networkInterfaces())){
      if (VIRTUAL_NAME_RE.test(name)) continue;
      for (const ni of list){
        if (ni.family !== 'IPv4' || ni.internal) continue;
        const ip = ni.address;
        if (isUnusableIPv4(ip)) continue;
        const score = isPrivateIPv4(ip) ? 100 : 1;
        all.push({ ip, name, score });
        if (!best || score > best.score) best = all[all.length - 1];
      }
    }
  } catch(e) {}
  return { ip: best ? best.ip : null, all };
}

/* ============ 启动 ============ */
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') console.error('[启动失败] 端口 ' + PORT + ' 已被占用，换一个：node server.js --port 9001');
  else if (e && e.code === 'EACCES') console.error('[启动失败] 无权绑定端口 ' + PORT + '（1024 以下端口通常需要管理员/root）');
  else console.error('[启动失败] ' + (e && e.message ? e.message : e));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const lan = pickLanIP();
  console.log('TANK 1998 双人服务器已启动' + (tlsOpts ? '（HTTPS / wss）' : '（HTTP / ws）'));
  console.log('  本机：  ' + SCHEME + '://localhost:' + PORT);
  if (lan.ip) console.log('  局域网：' + SCHEME + '://' + lan.ip + ':' + PORT + '  （同 WiFi 设备用此地址）');
  else console.log('  未检测到可用局域网 IPv4，请在系统设置中手动查看本机 IP');
  if (lan.all.length > 1){
    const others = lan.all.filter(x => x.ip !== lan.ip).map(x => x.ip + (x.score >= 100 ? '' : '[公网/特殊]')).join(', ');
    console.log('  其他候选：' + others);
  }
  console.log('  健康检查：' + SCHEME + '://localhost:' + PORT + '/healthz');
  if (ALLOW_ORIGIN.length) console.log('  允许来源：' + ALLOW_ORIGIN.join(', '));
  console.log('  双人：打开页面 → 双人游戏 → 创建/加入房间');
  if (tlsOpts) console.log('  公网：把地址发给朋友即可（已启用 wss，HTTPS 页面可直接连）');
  else console.log('  公网：建议加 --tls-cert/--tls-key 直跑 HTTPS，或在前端套 Caddy/Nginx 终止 TLS');
});

/* 优雅关闭：给容器编排 / systemd 一个干净的退出路径 */
let closing = false;
function shutdown(sig){
  if (closing) return;
  closing = true;
  console.log('\n收到 ' + sig + '，正在关闭…');
  for (const [, room] of rooms){
    for (const k of ['hostTimer', 'guestTimer', 'timer']) if (room[k]) clearTimeout(room[k]);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();   // 兜底：连接没断干净也退出
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
