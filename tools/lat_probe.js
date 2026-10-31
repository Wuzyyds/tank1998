/* 中继往返延迟探针：测「房主连接 ↔ 中继 ↔ 客方连接」的真实往返，**不含游戏循环节拍**。
 *
 * 为什么需要它：游戏 HUD 上的「延迟」= 房主→客方→房主 的完整往返，等于 2×网络 RTT，
 * 再叠加客方「等下一个 30Hz 发包拍」的时间。数字偏高时，先跑这个脚本拿到**链路下限**，
 * 才能区分「网络差」还是「代码把节拍拖长了」。
 *
 * 用法: node tools/lat_probe.js [ws://host:port/ws]
 *   默认打 ws://203.195.198.58/ws（线上）；想测本地就传 ws://127.0.0.1:8080/ws
 * 输出: min / p50 / p90 / avg / max（毫秒）
 *   经验值：同城公网 p50 约 60~80ms 属正常；>150ms 才是链路问题。
 */
const URL = process.argv[2] || 'ws://203.195.198.58/ws';
const N = 60;
const TICK = 33;   // 模拟 30Hz

function open(){
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.onopen = () => res(ws);
    ws.onerror = (e) => rej(new Error('ws error: ' + (e && e.message)));
  });
}
function once(ws, pred, ms){
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting')), ms || 5000);
    const h = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (pred(m)){ clearTimeout(t); ws.removeEventListener('message', h); res(m); }
    };
    ws.addEventListener('message', h);
  });
}

(async () => {
  const host = await open();
  host.send(JSON.stringify({ type:'room', action:'create' }));
  const created = await once(host, m => m.type === 'room' && m.action === 'created');
  const code = created.code;
  console.log('房间号:', code);

  const guest = await open();
  guest.send(JSON.stringify({ type:'room', action:'join', code }));
  await once(guest, m => m.type === 'room' && m.action === 'joined');
  console.log('客方已加入');

  const sent = new Map();
  const rtts = [];
  let seq = 0;

  await new Promise((resolve) => {
    host.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'input' && typeof m.ack === 'number'){
        const t0 = sent.get(m.ack);
        if (t0){ rtts.push(performance.now() - t0); sent.delete(m.ack); }
        if (rtts.length >= N) resolve();
      }
    });

    // 客方收到快照立刻回 ack（不加人为延迟）→ 得到「网络 + 中继」的真实下限
    guest.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'state' && m.snap && typeof m.snap.seq === 'number'){
        guest.send(JSON.stringify({ type:'input', k:0, ack:m.snap.seq }));
      }
    });

    const timer = setInterval(() => {
      seq++;
      sent.set(seq, performance.now());
      host.send(JSON.stringify({ type:'state', snap:{ seq, s:'playing' } }));
      if (seq > N + 40){ clearInterval(timer); resolve(); }
    }, TICK);
  });

  const s = rtts.slice().sort((a, b) => a - b);
  const avg = rtts.reduce((a, b) => a + b, 0) / (rtts.length || 1);
  console.log('样本数:', rtts.length);
  console.log('min =', s[0]?.toFixed(1), 'ms');
  console.log('p50 =', s[Math.floor(s.length * 0.5)]?.toFixed(1), 'ms');
  console.log('p90 =', s[Math.floor(s.length * 0.9)]?.toFixed(1), 'ms');
  console.log('avg =', avg.toFixed(1), 'ms');
  console.log('max =', s[s.length - 1]?.toFixed(1), 'ms');
  host.close(); guest.close();
  process.exit(0);
})().catch(e => { console.error('探测失败:', e.message); process.exit(1); });
