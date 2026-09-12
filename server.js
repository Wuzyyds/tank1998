/* =========================================================
 * TANK 1998 · 双人合作 —— 本地中继服务器（零依赖）
 * 同一端口既托管静态游戏文件，又提供 WebSocket 中继 (/ws)。
 *   - 同一 WiFi/局域网：两设备打开 http://<本机局域网IP>:<PORT>
 *   - 跨互联网：把本端口映射/部署到公网，把地址发给朋友
 *   - 房间号：4 位易读码，容量 2，纯中继（服务器不跑任何游戏逻辑）
 * 运行：node server.js  （可选 --port 9000 或环境变量 PORT）
 * ========================================================= */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || (process.argv.includes('--port')
  ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 8080);
const RECONNECT_WINDOW = 20000;   // 掉线后保留房间与重连令牌的时长（毫秒）
const ROOM_CAP = 2;

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
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = safeJoin(ROOT, urlPath);
  if (!filePath){ res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err){ res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
});

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
  if (url.split('?')[0] !== '/ws'){ socket.destroy(); return; }
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
    else if (type === 'input' || type === 'state'){
      // 纯中继：原样转发给房间内另一方，并打 from 标签
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

/* ============ 启动 ============ */
server.listen(PORT, '0.0.0.0', () => {
  const ifaces = [];
  try {
    const os = require('os');
    for (const list of Object.values(os.networkInterfaces())){
      for (const ni of list){
        if (ni.family === 'IPv4' && !ni.internal) ifaces.push(ni.address);
      }
    }
  } catch(e) {}
  console.log('TANK 1998 双人服务器已启动');
  console.log('  本机：  http://localhost:' + PORT);
  if (ifaces.length) console.log('  局域网：http://' + ifaces[0] + ':' + PORT + '  （同 WiFi 设备用此地址）');
  console.log('  双人：打开页面 → 双人游戏 → 创建/加入房间');
  console.log('  跨互联网：把上述端口在路由器/云主机映射后，把地址发给朋友');
});
