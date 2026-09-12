// 杞昏绂荤嚎缂撳瓨锛氶缂撳瓨搴旂敤澶栧３涓庡叏閮ㄩ潤鎬佽祫婧愶紝绉佷汉鏁版嵁涓嶈繘鍏ョ紦瀛橈紙鏁版嵁淇濆瓨鍦ㄦ湰鏈哄瓨鍌ㄤ腑锛夈€?const VERSION = 'qingxing-v4';
const CORE = [
  '/',
  '/index.html',
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

async function precacheApp(cache) {
  try {
    await cache.addAll(CORE);
  } catch {
    // 鍗曚釜璧勬簮澶辫触涓嶉樆濉炲畨瑁咃紝鍓╀綑璧勬簮缁х画
  }
  try {
    const response = await fetch('/index.html', { cache: 'no-cache' });
    if (response.ok) {
      const html = await response.text();
      const urls = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map((m) => m[1]))];
      if (urls.length) {
        try {
          await cache.addAll(urls);
        } catch {
          // 涓埆璧勬簮澶辫触鍙帴鍙楋紝杩愯鏈熺紦瀛樹細琛ヤ笂
        }
      }
    }
  } catch {
    // 绂荤嚎瀹夎鏃惰烦杩?  }
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

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put('/index.html', copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cached = (await caches.match('/index.html')) || (await caches.match('/'));
          if (cached) return cached;
          const offline = await caches.match('/offline.html');
          if (offline) return offline;
          return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h1>鏆傛椂娌℃湁缃戠粶</h1><p>鎭㈠缃戠粶鍚庤閲嶆柊鎵撳紑銆?/p></html>', {
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
