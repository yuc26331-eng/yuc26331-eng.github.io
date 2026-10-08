// 轻行离线缓存：预缓存应用外壳与全部静态资源，私人数据不进入缓存（数据保存在本机存储中）。
// 每次发布必须递增这里的版本号：脚本字节变化才会触发浏览器安装新 Worker 并重新预缓存。
// 否则新构建即使已经上线，已经装过旧 Worker 的设备仍会一直命中旧 index.html 与旧 chunk。
//
// v65 起的安全性约定（修复 iPhone Safari / Web App 更新后无法启动）：
// 1. 安装只以“核心启动资源”是否齐全判定成功；入境指南大图等非核心资源失败不再阻断升级。
// 2. 核心资源在有限并发下抓取（不再逐个串行），缩短 iPhone 上的安装时间，也避免资源风暴。
// 3. 旧版本静态缓存不在 activate 阶段删除，而是等新版本页面确认自己启动成功后再安全清理，
//    杜绝“前端提示更新失败、后台却已激活并删掉旧缓存”的半新半旧状态（白屏根因）。
// 4. 这里只操作 Cache Storage 中的静态资源缓存，绝不触碰 IndexedDB / localStorage 用户数据。
const VERSION = 'qingxing-v67';

// 核心启动资源：只有全部成功才算安装成功，新版本必须能靠它们启动。
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

// 非核心资源：功能页大图等。安装阶段尽力缓存，失败不影响升级；首次使用时也会被运行时缓存。
const OPTIONAL = [
  '/guides/japan-entry/disembarkation-card.jpg',
  '/guides/japan-entry/customs-declaration.jpg',
];

// 必须在安装结束时已完整缓存、否则不允许激活的页面。
const REQUIRED_PAGES = ['/index.html', '/tools/index.html', '/translator/index.html', '/print/index.html'];
// 并发上限：既缩短安装时间，又避免 iOS Safari 上一次性发起过多请求。
const CONCURRENCY = 6;

// 有上限的并发执行，保持输入顺序。
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(Math.max(1, limit), Math.max(1, items.length))).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

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

// 抓取单个资源并写入缓存；绕开浏览器 HTTP 缓存，避免把旧 chunk 当成新版本缓存起来。
async function fetchInto(cache, url) {
  const response = await fetch(url, { cache: 'reload' });
  if (!response.ok) throw new Error('precache-failed:' + url);
  await cache.put(url, response.clone());
  return response;
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
  // 有限并发抓取页面引用的 chunk / CSS；不再逐个串行等待。
  await mapLimit(urls, CONCURRENCY, (url) => fetchInto(cache, url));
  for (const url of urls) {
    if (!(await cache.match(url))) throw new Error('precache-asset-missing:' + url);
  }
}

async function precacheCore(cache) {
  // 不能用 cache.addAll：它允许命中浏览器 HTTP 缓存，会把旧 shell/旧 chunk 缓存进新版本。
  await mapLimit(CORE, CONCURRENCY, (url) => fetchInto(cache, url));
  // 用目录地址（而不是 *.html）预缓存页面：部分静态托管会把 *.html 301 到扩展名路径。
  await precachePage(cache, '/');
  await precachePage(cache, '/tools/');
  await precachePage(cache, '/translator/');
  await precachePage(cache, '/print/');
  // 全部离线页面和它们的 JS/CSS 都已缓存后才允许激活；失败时继续使用旧 Worker。
  const complete = await Promise.all(REQUIRED_PAGES.map((key) => cache.match(key)));
  if (complete.some((response) => !response)) throw new Error('precache-incomplete');
  return cache;
}

// 非核心资源：失败只记录，不影响安装结果，也不删除已缓存内容。
async function precacheOptional(cache) {
  await mapLimit(OPTIONAL, Math.min(CONCURRENCY, 3), async (url) => {
    try {
      await fetchInto(cache, url);
    } catch {
      // 大图等资源失败时忽略：首次使用时运行时会再尝试缓存。
    }
  });
  return cache;
}

async function currentCacheIsComplete() {
  if (!(await caches.has(VERSION))) return false;
  try {
    const existing = await caches.open(VERSION);
    const pages = await Promise.all(REQUIRED_PAGES.map((key) => existing.match(key)));
    return pages.every(Boolean);
  } catch {
    return false;
  }
}

async function cleanOldCaches() {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('qingxing-') && key !== VERSION).map((key) => caches.delete(key)));
  } catch {
    // 清理失败不影响新版本使用。
  }
}

self.addEventListener('install', (event) => {
  let hadCompleteCache = false;
  event.waitUntil(
    (async () => {
      // 同版本因不同注册地址再次安装时，失败不能删掉已激活版本的完整缓存。
      hadCompleteCache = await currentCacheIsComplete();
      const cache = await caches.open(VERSION);
      try {
        await precacheCore(cache);
        // 非核心资源放在核心成功之后，且失败不抛出。
        await precacheOptional(cache);
      } catch (error) {
        // 移除失败安装留下的部分缓存，避免缓存增长或激活缺资源的新版本。
        const activeVersion = self.registration.active ? new URL(self.registration.active.scriptURL).searchParams.get('v') : null;
        if (!hadCompleteCache && activeVersion !== VERSION) await caches.delete(VERSION);
        throw error;
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 只接管页面，不在此时删除任何旧缓存。
      // 旧缓存会在新版本页面确认启动成功后通过 CACHE_READY 消息清理，
      // 这样即使前端误判超时、旧页面仍在运行，也能继续从旧缓存读取自身资源，不会白屏。
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (type === 'CACHE_READY') {
    // 新版本页面已成功启动：此时清理旧版本静态缓存是安全的。
    event.waitUntil(cleanOldCaches());
  }
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