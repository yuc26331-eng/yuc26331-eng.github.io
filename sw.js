// 轻行离线缓存：预缓存应用外壳与全部静态资源，私人数据不进入缓存（数据保存在本机存储中）。
const VERSION = 'qingxing-v15';
const CORE = [
  '/',
  '/index.html',
  '/tools/',
  '/tools/index.html',
  '/compat.js',
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/covers/dali.jpg',
  '/covers/hangzhou.jpg',
  '/covers/kyoto.jpg',
];

async function precachePage(cache, pagePath) {
  try {
    const response = await fetch(pagePath, { cache: 'no-cache' });
    if (!response.ok) return;
    const html = await response.text();
    const urls = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map((m) => m[1]))];
    if (urls.length) {
      try {
        await cache.addAll(urls);
      } catch {
        // 个别资源失败可接受，运行期缓存会补上
      }
    }
  } catch {
    // 离线安装时跳过
  }
}

async function precacheApp(cache) {
  try {
    await cache.addAll(CORE);
  } catch {
    // 单个资源失败不阻塞安装，剩余资源继续
  }
  await precachePage(cache, '/index.html');
  await precachePage(cache, '/tools/index.html');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => precacheApp(cache))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('qingxing-') && key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/version.json') return; // 更新检查必须走网络

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            const key = url.pathname.startsWith('/tools') ? '/tools/index.html' : '/index.html';
            caches.open(VERSION).then((cache) => cache.put(key, copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const exact = await caches.match(request, { ignoreSearch: true });
          if (exact) return exact;
          const page = (await caches.match('/index.html')) || (await caches.match('/'));
          if (page) return page;
          const offline = await caches.match('/offline.html');
          if (offline) return offline;
          return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h1>暂时没有网络</h1><p>恢复网络后请重新打开。</p></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html;charset=utf-8' },
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok && (url.pathname.startsWith('/_next/') || /\.(?:js|css|png|jpe?g|svg|webp|gif|ico|woff2?|ttf)$/i.test(url.pathname))) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached || Response.error());
    })
  );
});
