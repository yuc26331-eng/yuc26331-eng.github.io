// 轻行离线缓存：预缓存应用外壳与全部静态资源，私人数据不进入缓存（数据保存在本机存储中）。
// 每次发布必须递增这里的版本号：脚本字节变化才会触发浏览器安装新 Worker 并重新预缓存。
// 否则新构建即使已经上线，已经装过旧 Worker 的设备仍会一直命中旧 index.html 与旧 chunk。
const VERSION = 'qingxing-v51';
const CORE = [
  '/',
  '/index.html',
  '/tools/',
  '/tools/index.html',
  '/translator/',
  '/translator/index.html',
  '/print/',
  '/print/index.html',
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

// 导航缓存键：把目录路径规范成它以 index.html 结尾的等价形式。
function navCacheKey(url) {
  const p = url.pathname;
  if (p.endsWith('/')) return p + 'index.html';
  if (p.endsWith('.html')) return p;
  return p + '/index.html';
}

// 离线兜底页：被 301 跳转后缓存下来的响应带 redirected 标记，
// 直接作为导航响应返回会让浏览器报 ERR_FAILED，需要用它的正文重建一份普通 Response。
async function offlinePage() {
  for (const key of ['/offline', '/offline.html']) {
    const hit = await caches.match(key);
    if (!hit) continue;
    if (!hit.redirected) return hit;
    try {
      const text = await hit.clone().text();
      return new Response(text, { status: 200, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    } catch {
      // 读取失败时继续找下一个候选
    }
  }
  return null;
}

// 离线导航查找：先精确匹配，再按规范键/目录形式依次尝试；
// 绝不用另一个功能页面的缓存顶替。
async function matchNavigation(request, url) {
  const p = url.pathname;
  const keys = [p, navCacheKey(url)];
  if (p.endsWith('/')) keys.push(p.slice(0, -1));
  if (!p.endsWith('.html') && !p.endsWith('/')) keys.push(p + '/', p);
  for (const key of [...new Set(keys)]) {
    const hit = await caches.match(key, { ignoreSearch: true });
    if (hit) return hit;
  }
  return caches.match(request, { ignoreSearch: true });
}

async function precachePage(cache, pagePath) {
  const response = await fetch(pagePath, { cache: 'reload' });
  if (!response.ok) throw new Error('precache-page-failed:' + pagePath);
  const html = await response.clone().text();
  // 页面 HTML 本身也要按规范键缓存，离线导航才能直接命中，而不是只缓存它引用的 JS/CSS。
  const key = navCacheKey(new URL(pagePath, self.location.href));
  if (!response.redirected) await cache.put(key, response);
  else {
    const direct = await fetch(response.url, { cache: 'reload' });
    if (!direct.ok) throw new Error('precache-page-redirect-failed:' + pagePath);
    await cache.put(key, direct);
  }
  const urls = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map((m) => m[1]))];
  // 逐个绕过 HTTP 缓存抓取资源；cache.addAll 会把旧 chunk 当成新版本缓存起来。
  for (const url of urls) {
    const asset = await fetch(url, { cache: 'reload' });
    if (!asset.ok) throw new Error('precache-asset-failed:' + url);
    await cache.put(url, asset);
  }
  for (const url of urls) {
    if (!(await cache.match(url))) throw new Error('precache-asset-missing:' + url);
  }
}

async function precacheApp(cache) {
  // 不能用 cache.addAll：它允许命中浏览器 HTTP 缓存，会把旧 shell/旧 chunk 缓存进新版本。
  for (const url of CORE) {
    const response = await fetch(url, { cache: 'reload' });
    if (!response.ok) throw new Error('precache-core-failed:' + url);
    await cache.put(url, response);
  }
  // 用目录地址（而不是 *.html）预缓存页面：部分静态托管会把 *.html 301 到扩展名路径。
  await precachePage(cache, '/');
  await precachePage(cache, '/tools/');
  await precachePage(cache, '/translator/');
  await precachePage(cache, '/print/');
  return cache;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => precacheApp(cache))
      .then(async (cache) => {
        // 全部离线页面和它们的 JS/CSS 都已缓存后才允许激活；失败时继续使用旧 Worker。
        const requiredPages = ['/index.html', '/tools/index.html', '/translator/index.html', '/print/index.html'];
        const complete = await Promise.all(requiredPages.map((key) => cache.match(key)));
        if (complete.some((response) => !response)) throw new Error('precache-incomplete');
      })
      .catch(async (error) => {
        // 移除失败安装留下的部分缓存，避免缓存增长或激活缺资源的新版本。
        await caches.delete(VERSION);
        throw error;
      })
      .then(() => self.skipWaiting())
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
          // 按真实路径缓存导航响应：不能把翻译页写进 /index.html，
          // 否则离线时任何未缓存页面都会拿到另一个功能页面。
          if (response && response.ok && !response.redirected) {
            const copy = response.clone();
            const key = navCacheKey(url);
            caches.open(VERSION).then((cache) => cache.put(key, copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cached = await matchNavigation(request, url);
          if (cached) return cached;
          const offline = await offlinePage();
          if (offline) return offline;
          return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><h1>这个页面还没有离线缓存</h1><p>当前设备离线，且该页面从未在线打开过。联网后重新打开即可。</p>', {
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
          // PDF.js loads .mjs workers, .bcmap CMaps and .pfb fonts; Tesseract loads .gz language data.
          // Cache these same-origin resources only after first use, keeping the initial install small.
          if (response && response.ok && (url.pathname.startsWith('/_next/') || /\.(?:js|mjs|css|png|jpe?g|svg|webp|gif|ico|woff2?|ttf|gz|bcmap|pfb|wasm)$/i.test(url.pathname))) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached || Response.error());
    })
  );
});
