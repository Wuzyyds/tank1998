/* GitHub 推送隧道（本机网络环境专用）
 *
 * 为什么需要它：本机 DNS 解析 github.com 得到 20.205.243.166，该 IP 直连超时，
 * 而走系统代理（127.0.0.1:8431）返回 502 CONNECT tunnel failed。
 * 但 GitHub 的其他边缘 IP（140.82.112.3 等）直连正常，api.github.com 也一直直连可用。
 *
 * 所以这里起一个**本地 CONNECT 隧道**，把 github.com 的 TLS 连接改投到可用 IP，
 * 让 `git push` 走 http.proxy 绕过去，不需要改 hosts、不需要管理员权限。
 *
 * 用法（两个终端）：
 *   1) node tools/gh_tunnel.js
 *   2) git -c http.proxy=http://127.0.0.1:8899 push -u origin main --tags
 *      （PowerShell 下要先清掉环境变量：$env:https_proxy=""）
 *
 * ⚠️ 只在「github.com 直连不通」时用。若 `curl -I https://github.com` 能返回 200，
 *    说明网络已经正常，直接用普通 git push 即可，别多绕一层。
 * ⚠️ 只映射 github.com —— 绝不能把 api.github.com 一起映射，两者是不同 IP，
 *    指错会让 GCM（Git Credential Manager）的认证请求返回 406，表现为
 *    「响应状态代码不指示成功: 406」。这个坑真踩过。
 */
const net = require('net');

const GITHUB_IPS = ['140.82.112.3', '140.82.114.3', '20.27.177.113', '140.82.121.4'];
const PORT = 8899;

/* 依次试几个 IP，用第一个能连通 443 的 */
function pickIP() {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= GITHUB_IPS.length) return resolve(null);
      const ip = GITHUB_IPS[i++];
      const s = net.connect(443, ip, () => { s.destroy(); resolve(ip); });
      s.on('error', next);
      setTimeout(() => { try { s.destroy(); } catch (e) {} next(); }, 3000);
    };
    next();
  });
}

(async () => {
  const ip = await pickIP();
  if (!ip) { console.error('所有备用 IP 都连不上 443，放弃'); process.exit(1); }

  net.createServer((c) => {
    c.on('error', () => {});
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      c.removeListener('data', onData);
      const m = /^CONNECT\s+([^:]+):(\d+)/i.exec(buf.split('\r\n')[0]);
      if (!m) { try { c.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {} return; }
      const host = m[1], port = Number(m[2]);
      const up = net.connect(port, host === 'github.com' ? ip : host, () => {
        c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = buf.slice(idx + 4);
        if (rest) up.write(Buffer.from(rest, 'latin1'));
        c.pipe(up); up.pipe(c);
      });
      up.on('error', () => { try { c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
    };
    c.on('data', onData);
  }).listen(PORT, '127.0.0.1', () => {
    console.log('github.com -> ' + ip + '，隧道监听 127.0.0.1:' + PORT);
    console.log('推送：git -c http.proxy=http://127.0.0.1:' + PORT + ' push -u origin main --tags');
  });
})();
