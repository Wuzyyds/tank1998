/* =========================================================
 * TANK 1998 · Service Worker（离线缓存）
 * 策略：同源 GET 走「网络优先、缓存回退」——
 *   - 在线时始终拿最新代码，并顺手写入缓存
 *   - 离线时用缓存渲染，实现可安装 + 离线可玩
 * 发布新版本时请提升 VERSION，旧缓存会在 activate 阶段清理。
 *
 * ⚠️ SHELL 里**故意不放** assets/sounds.js：那是 13 个 wav 的 base64 兜底包（约 190KB），
 * 只有「.wav 取不到」时才会被 game.js 按需注入。放进预缓存清单等于每次安装都白拉一遍，
 * 按需加载就白做了。离线时的音效由运行时缓存下来的 .wav 负责（fetch 处理器会顺手缓存）。
 * ========================================================= */
'use strict';

const VERSION = 'tank1998-v1.7.0';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './net.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .catch(() => {})            // 任一资源缺失也不阻塞安装
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/ws') return;              // WebSocket 升级请求不缓存

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit => hit || caches.match('./index.html'))
      )
  );
});
