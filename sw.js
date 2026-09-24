// 轻行离线缓存：只有全部关键资源完整写入后才激活；私人数据不进入缓存。
const VERSION = 'qingxing-v40';
const INSTALL_MARKER = '/__qingxing_install_ok__';
const CORE = [
  '/',
  '/index.html',
  '/tools/',
  '/tools/index.html',
  '/translator/',
  '/translator/index.html',
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

async function fetchAndCache(cache, url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error('关键资源下载失败：' + response.status + ' ' + url);
  await cache.put(url, response.clone());
  return response;
}

async function precachePage(cache, pagePath) {
  const response = await fetchAndCache(cache, pagePath);
  const html = await response.text();
  const urls = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map((m) => m[1]))];
  for (const url of urls) await fetchAndCache(cache, url);
}

async function precacheApp(cache) {
  await cache.addAll(CORE);
  await precachePage(cache, '/index.html');
  await precachePage(cache, '/tools/index.html');
  await precachePage(cache, '/translator/index.html');
  await cache.put(INSTALL_MARKER, new Response('ok', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // 失败安装留下的残片不参与后续判断，也不触碰旧缓存。
    await caches.delete(VERSION);
    try {
      const cache = await caches.open(VERSION);
      await precacheApp(cache);
      await self.skipWaiting();
    } catch (error) {
      await caches.delete(VERSION).catch(() => {});
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const marker = await cache.match(INSTALL_MARKER);
    if (!marker) {
      // 未确认完整的新缓存绝不接管，也绝不删除仍可用的旧缓存。
      await self.clients.claim();
      return;
    }
    // 先接管客户端，避免旧 Worker 在清理期间再次写入旧缓存。
    await self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key.startsWith('qingxing-') && key !== VERSION).map((key) => caches.delete(key))
    );
  })());
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
  if (url.pathname === '/version.json' || url.pathname === INSTALL_MARKER) return;

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
