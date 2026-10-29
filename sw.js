// 轻行离线缓存：只预缓存应用外壳与静态资源。共享 API 数据不进入 Cache Storage；
// 已下载的业务数据与离线待同步记录保存在独立 IndexedDB 镜像中。
// 每次发布必须递增这里的版本号：脚本字节变化才会触发浏览器安装新 Worker 并重新预缓存。
// 否则新构建即使已经上线，已经装过旧 Worker 的设备仍会一直命中旧 index.html 与旧 chunk。
//
// v65 起的安全性约定（修复 iPhone Safari / Web App 更新后无法启动）：
// 1. 安装只以“核心启动资源”是否齐全判定成功；入境指南大图等非核心资源失败不再阻断升级。
// 2. 核心资源在有限并发下抓取（不再逐个串行），缩短 iPhone 上的安装时间，也避免资源风暴。
// 3. 旧版本静态缓存不在 activate 阶段删除，而是等新版本页面确认自己启动成功后再安全清理，
//    杜绝“前端提示更新失败、后台却已激活并删掉旧缓存”的半新半旧状态（白屏根因）。
// 4. 这里只操作 Cache Storage 中的静态资源缓存，绝不触碰 IndexedDB / localStorage 用户数据。
const VERSION = 'qingxing-v109';
// 旧版Worker只清理qingxing-*：隔离正在安装的缓存，防止旧页面确认时误删它。
const STAGE_PREFIX = 'qx-static-'+VERSION+'-repair-';

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
  '/help/',
  '/help/index.html',
  '/compat.js',
  '/interface.js',
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

// 非核心资源：功能页大图等。页面启动后尽力缓存，失败不影响升级；首次使用时也会被运行时缓存。
const OPTIONAL = [
  '/guides/japan-entry/disembarkation-card.jpg',
  '/guides/japan-entry/customs-declaration.jpg',
];

// 必须在安装结束时已完整缓存、否则不允许激活的页面。
const REQUIRED_PAGES = ['/index.html', '/tools/index.html', '/translator/index.html', '/print/index.html', '/help/index.html'];
// 并发上限：既缩短安装时间，又避免 iOS Safari 上一次性发起过多请求。
const CONCURRENCY = 2;

// 有上限的并发执行，保持输入顺序。
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let failed = false;
  const runners = new Array(Math.min(Math.max(1, limit), Math.max(1, items.length))).fill(0).map(async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try {results[index] = await worker(items[index], index);}catch(error){failed=true;throw error;}
    }
  });
  const completed=await Promise.allSettled(runners);
  const failure=completed.find(result=>result.status==='rejected');if(failure)throw failure.reason;
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
  const current=await caches.open(await activeCacheName());
  for (const key of ['/offline', '/offline.html']) {
    const hit = await current.match(key)||await caches.match(key);
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
  const current=await caches.open(await activeCacheName());
  const p = url.pathname;
  const keys = [p, navCacheKey(url)];
  if (p.endsWith('/')) keys.push(p.slice(0, -1));
  if (!p.endsWith('.html') && !p.endsWith('/')) keys.push(p + '/', p);
  for (const key of [...new Set(keys)]) {
    const hit = await current.match(key,{ignoreSearch:true})||await caches.match(key, { ignoreSearch: true });
    if (hit) return hit;
  }
  return await current.match(request,{ignoreSearch:true})||caches.match(request, { ignoreSearch: true });
}

// 抓取单个资源并写入缓存；绕开浏览器 HTTP 缓存，避免把旧 chunk 当成新版本缓存起来。
async function matchesResource(response, record) {
  if (!response?.ok) return false;
  try{
    const bytes=await response.clone().arrayBuffer();
    if(bytes.byteLength!==record.size)return false;
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
    return hash===record.sha256;
  }catch{return false;}
}
// Public resource metadata only: no travel records, credentials or attachment contents.
const DIAGNOSTICS_CACHE = 'qx-update-diagnostics';
function resourceError(cause, detail) {
  const error = new Error('precache-failed: '+detail.path+' · '+detail.phase+' · '+String(cause));
  error.detail = {...detail, errorType:cause?.name||'Error', underlying:String(cause)};
  return error;
}
function decodedResponse(bytes,response){
  // Fetch has already decoded gzip/br. Transport headers describe the wire body,
  // not these bytes, and must not be persisted on a reconstructed response.
  const headers=new Headers(response.headers);
  for(const name of ['content-encoding','content-length','transfer-encoding','set-cookie'])headers.delete(name);
  return new Response(bytes,{status:response.status,statusText:response.statusText,headers});
}
async function reportInstallFailure(error) {
  const diagnostic = {version:VERSION, time:new Date().toISOString(), phase:'install', errorType:error?.name||'Error', underlying:String(error), ...error.detail, message:String(error)};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
  try{await fetch(new URL('/api/update-diagnostic',self.location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(diagnostic),credentials:'same-origin',signal:controller.signal});}catch{}finally{clearTimeout(timer);}
  // A full/disabled Cache Storage must not hide the original exception.
  try { await (await caches.open(DIAGNOSTICS_CACHE)).put('/last-failure', new Response(JSON.stringify(diagnostic), {headers:{'Content-Type':'application/json'}})); } catch {}
  try { for (const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})) client.postMessage?.({type:'QX_UPDATE_FAILURE',diagnostic}); } catch {}
  console.error('QX_UPDATE_FAILURE', JSON.stringify(diagnostic));
}
async function fetchInto(cache, url, record=null, previousCaches=[], attempts=2) {
  // An unreadable old cache is not proof that the published resource is bad.
  // Ignore failed reads and verify a fresh download instead of aborting install.
  if(record){
    for(const previous of [cache,...previousCaches]){
      let hit;
      try { hit=await previous.match(url); } catch { continue; }
      if(await matchesResource(hit,record)){
        let normalized;try{normalized=decodedResponse(await hit.arrayBuffer(),hit);}catch{continue;}
        if(previous!==cache){try{await cache.put(url,normalized.clone());}catch(error){throw resourceError(error,{path:url,url:new URL(url,self.location.href).href,phase:'cache-write-reused'});}}
        return normalized;
      }
    }
  }
  let response,detail;
  for(let attempt=0;attempt<attempts;attempt++){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),attempt===0?15000:30000);
    const target=new URL(url==='/offline-resources.json'?'/api/update-manifest':record?'/api/update-resource':url,self.location.href);
    if(url==='/offline-resources.json'||record)target.searchParams.set('sw',VERSION);
    if(record){target.searchParams.set('path',url);target.searchParams.set('sha256',record.sha256);}
    if(attempt)target.searchParams.set('qx_retry',VERSION+'-'+Date.now());
    detail={path:url,url:target.href,phase:'download',attempt:attempt+1};
    try{
      let fetched=await fetch(target.href,{cache:'reload',signal:controller.signal});
      // Static hosts have no /api routes. Preserve the exact same manifest/SHA checks.
      if ([404,405,501].includes(fetched.status) && target.pathname.startsWith('/api/update-')) {
        const direct=new URL(url,self.location.href);direct.searchParams.set('qx_release',VERSION);
        fetched=await fetch(direct.href,{cache:'reload',signal:controller.signal});
      }
      Object.assign(detail,{status:fetched.status,finalUrl:fetched.url||target.href,redirected:fetched.redirected,contentType:fetched.headers.get('content-type'),responseType:fetched.type});
      if(!fetched.ok)throw new Error('HTTP '+fetched.status);
      if(fetched.url&&new URL(fetched.url).origin!==self.location.origin)throw new Error('Cross-origin redirect refused');
      detail.phase='read-body';
      const bytes=await fetched.arrayBuffer();
      detail.actualSize=bytes.byteLength;
      response=decodedResponse(bytes,fetched);
      if(record){
        detail.phase='verify-size';detail.expectedSize=record.size;
        if(bytes.byteLength!==record.size)throw new Error('Size mismatch: expected '+record.size+', received '+bytes.byteLength);
        detail.phase='verify-sha256';detail.expectedHash=record.sha256;
        detail.actualHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
        if(detail.actualHash!==record.sha256)throw new Error('SHA-256 mismatch');
      }
      break;
    }catch(error){
      if(attempt+1===attempts)throw resourceError(error,detail);
    }finally{clearTimeout(timer);}
  }
  detail.phase='cache-write';
  try{await cache.put(url,response.clone());}catch(error){throw resourceError(error,detail);}
  return response;
}

async function precacheCore(cache) {
  const manifest=await (await fetchInto(cache,'/offline-resources.json')).json();
  if(manifest.format!=='qingxing-offline-resources-v1'||manifest.sw!==VERSION||!Array.isArray(manifest.core)||!Array.isArray(manifest.resources))throw new Error('离线清单与当前缓存版本不一致');
  const records=new Map(manifest.resources.map(row=>[row.path,row]));
  const paths=[...new Set([...manifest.core,...CORE.map(value=>value.endsWith('/')?value+'index.html':value)])];
  for(const value of paths){const row=records.get(value);if(!value.startsWith('/')||value.startsWith('//')||!row||!Number.isSafeInteger(row.size)||row.size<0||!/^[a-f0-9]{64}$/.test(row.sha256))throw new Error('无效核心资源记录: '+value);}
  const previousResults=await Promise.allSettled((await caches.keys()).filter(name=>/^(?:qx-static-)?qingxing-v\d+(?:$|-repair-)/.test(name)).map(name=>caches.open(name)));
  const previousCaches=previousResults.filter(result=>result.status==='fulfilled').map(result=>result.value);
  // 以清单的规范键缓存，每个共享JS/CSS只下载一次；Response重建消除导航重定向标记。
  let done=0;
  await mapLimit(paths,CONCURRENCY,async value=>{
    await fetchInto(cache,value,records.get(value),previousCaches);done++;
    try{for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true}))client.postMessage?.({type:'QX_UPDATE_PROGRESS',version:VERSION,done,total:paths.length,path:value});}catch{}
  });
  // 全部离线页面和它们的 JS/CSS 都已缓存后才允许激活；失败时继续使用旧 Worker。
  const complete = await Promise.all(REQUIRED_PAGES.map((key) => cache.match(key)));
  if (complete.some((response) => !response)) throw new Error('precache-incomplete');
  return cache;
}

// 非核心资源：失败只记录，不影响安装结果，也不删除已缓存内容。
async function precacheOptional(cache) {
  await mapLimit(OPTIONAL, Math.min(CONCURRENCY, 3), async (url) => {
    try {
      await fetchInto(cache, url,null,[],1);
    } catch {
      // 大图等资源失败时忽略：首次使用时运行时会再尝试缓存。
    }
  });
  return cache;
}

const CACHE_STATE='qingxing-cache-state';
const readyClients=new Map();
let repairJob=null;
let cleanupJob=null;
let optionalJob=null;
function cacheOptionalOnce(){
  if(!optionalJob)optionalJob=activeCacheName().then(name=>caches.open(name)).then(precacheOptional).catch(()=>{});
  return optionalJob;
}
async function activeCacheName(){
  try{const response=await (await caches.open(CACHE_STATE)).match('/active-cache');const row=response?await response.json():null;
    if(row&&row.version===VERSION&&typeof row.active==='string'&&(row.active===VERSION||row.active.startsWith(VERSION+'-repair-')||row.active.startsWith(STAGE_PREFIX))&&await caches.has(row.active))return row.active;
  }catch{}
  return VERSION;
}
async function cacheIsComplete(cache){
  const manifestResponse=await cache.match('/offline-resources.json');if(!manifestResponse?.ok)return false;
  const manifest=await manifestResponse.json();
  if(manifest.format!=='qingxing-offline-resources-v1'||manifest.sw!==VERSION||!Array.isArray(manifest.core)||!Array.isArray(manifest.resources))return false;
  const records=new Map(manifest.resources.map(row=>[row.path,row]));
  for(const path of manifest.core){
    const row=records.get(path),response=await cache.match(path);if(!row||!response?.ok)return false;
    const bytes=await response.arrayBuffer();if(bytes.byteLength!==row.size)return false;
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');if(hash!==row.sha256)return false;
  }
  for(const key of CORE.filter(path=>path!=='/'&&!path.endsWith('/'))){if(!(await cache.match(key))?.ok)return false;}
  for(const key of REQUIRED_PAGES){
    const response=await cache.match(key);if(!response?.ok)return false;
    const html=await response.text();const assets=[...html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map(match=>match[1]);
    if(!html.trim()||!assets.length)return false;
    for(const asset of assets)if(!(await cache.match(asset))?.ok)return false;
  }
  return true;
}
async function currentCacheIsComplete(){
  try{const name=await activeCacheName();return await caches.has(name)&&await cacheIsComplete(await caches.open(name));}catch{return false;}
}
async function setActiveCache(name){await (await caches.open(CACHE_STATE)).put('/active-cache',new Response(JSON.stringify({version:VERSION,active:name}),{headers:{'Content-Type':'application/json'}}));}
async function rebuildCore(reuseVerified=false){
  if(repairJob)return repairJob;
  repairJob=(async()=>{
    // 清理与重建互斥，防止另一页面刚确认就删除仍在生成的新缓存。
    if(cleanupJob)await cleanupJob;
    // Old pages register /sw.js?v=90 at startup even after this release is live.
    // Registering the same release later under ?v=102 must not allocate it again.
    if(reuseVerified&&await currentCacheIsComplete())return await activeCacheName();
    // A foreground updater may already have downloaded and verified this release.
    // Adopt it in place, avoiding a second core copy on storage-limited iPhones.
    for(const candidate of (await caches.keys()).filter(key=>key.startsWith(STAGE_PREFIX+'window-'))){
      try{if(await cacheIsComplete(await caches.open(candidate))){await setActiveCache(candidate);return candidate;}}catch{}
    }
    const name=STAGE_PREFIX+Date.now()+'-'+Math.random().toString(36).slice(2);let committed=false;
    let stage;try{stage=await caches.open(name);}catch(error){throw resourceError(error,{path:name,phase:'cache-open'});}
    try{
      await precacheCore(stage);
      if(!await cacheIsComplete(stage)||!await caches.has(name))throw new Error('新缓存缺少核心页面或资源');
      await setActiveCache(name);
      committed=true;
      // 保留这一份已校验的在用缓存，避免安装时再复制一整份而占满iPhone存储。
      return await activeCacheName();
    }finally{
      // 只回收本次从未启用的失败缓存；绝不删除旧版本、旧在用stage或用户数据库。
      if(!committed)await caches.delete(name).catch(()=>false);
    }
  })().finally(()=>{repairJob=null;});return repairJob;
}
async function performCacheCleanup(){
  if(repairJob)return {complete:false,waiting:0,removed:[],repairing:true};
  if(!await currentCacheIsComplete())return {complete:false,waiting:0,removed:[]};
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const waiting=clients.filter(client=>readyClients.get(client.id)!==VERSION).length;
  if(waiting)return {complete:true,waiting,removed:[]};
  const current=await activeCacheName();
  const keys=await caches.keys();
  // 完整性核验期间可能收到修复请求：不能把仍在写入的新stage作为旧缓存删除。
  if(repairJob)return {complete:true,waiting:0,removed:[],repairing:true};
  const versionNumber=Number(VERSION.match(/\d+$/)[0]);
  const removed=keys.filter(key=>{
    const match=/^(?:qx-static-)?qingxing-v(\d+)(?:$|-repair-)/.exec(key);
    // 只回收本版或更早的静态缓存；未来版本可能仍在安装，未知缓存也保留。
    return match&&Number(match[1])<=versionNumber&&key!==current;
  });
  await Promise.all(removed.map(key=>caches.delete(key)));
  return {complete:true,waiting:0,removed};
}
async function cleanOldCaches(){
  if(repairJob)return {complete:false,waiting:0,removed:[],repairing:true};
  if(cleanupJob)return cleanupJob;
  cleanupJob=performCacheCleanup().finally(()=>{cleanupJob=null;});
  return cleanupJob;
}
self.addEventListener('install',event=>{event.waitUntil((async()=>{try{await rebuildCore(true);await self.skipWaiting();}catch(error){await reportInstallFailure(error);throw error;}})());});

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

self.addEventListener('message',event=>{
  const type=event.data&&event.data.type;
  if(type==='SKIP_WAITING'){
    // Only a fully verified release can take over; old pages may send no version.
    event.waitUntil((async()=>{if((!event.data.version||event.data.version===VERSION)&&await currentCacheIsComplete())await self.skipWaiting();})());return;
  }
  if(type==='CACHE_READY'){
    if(event.data.version===VERSION&&event.source?.id)readyClients.set(event.source.id,VERSION);
    event.waitUntil((async()=>{try{const result=await cleanOldCaches();event.ports?.[0]?.postMessage({ok:true,version:VERSION,...result});}catch(error){event.ports?.[0]?.postMessage({ok:false,error:String(error)});}await cacheOptionalOnce();})());return;
  }
  if(type==='REPAIR_CACHE'||type==='VERIFY_CACHE'){
    event.waitUntil((async()=>{
      try{const name=type==='REPAIR_CACHE'?await rebuildCore():await activeCacheName();const ok=await cacheIsComplete(await caches.open(name));event.ports?.[0]?.postMessage({ok,version:VERSION,cacheName:name});}
      catch(error){event.ports?.[0]?.postMessage({ok:false,version:VERSION,error:String(error),diagnostic:error.detail});}
    })());
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
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/signin-') || url.pathname.startsWith('/signout-') || url.pathname === '/callback' || request.headers.has('authorization')) return;
  if (url.pathname === '/version.json' || url.pathname === '/offline-resources.json' || url.pathname === '/update-recovery.html' || url.pathname === '/upgrade-v2.html' || url.pathname === '/update-recovery.js') return; // 更新检查必须走网络

  if (request.mode === 'navigate') {
    event.respondWith(
      (async()=>{const cache=await caches.open(await activeCacheName());const core=REQUIRED_PAGES.includes(navCacheKey(url))?await cache.match(navCacheKey(url)):null;if(core)return core;return fetch(request);})()
        .then((response) => {
          // 按真实路径缓存导航响应：不能把翻译页写进 /index.html，
          // 否则离线时任何未缓存页面都会拿到另一个功能页面。
          if (response && response.ok && !response.redirected) {
            const copy = response.clone();
            const key = navCacheKey(url);
            activeCacheName().then(name=>caches.open(name)).then((cache) => cache.put(key, copy)).catch(() => {});
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
    activeCacheName().then(name=>caches.open(name)).then(cache=>cache.match(request)).then(async (current)=>{const cached=current||(url.pathname.startsWith('/_next/static/')?await caches.match(request):undefined);
      // Hashed chunks are immutable. A reload of an old HTML page must still
      // use its cached chunk after a release removes that URL from the origin.
      if (cached && (url.pathname.startsWith('/_next/static/') || request.cache!=='reload' && request.cache!=='no-store')) return cached;
      return fetch(request)
        .then((response) => {
          if (!response.ok && cached) return cached;
          // PDF.js loads .mjs workers, .bcmap CMaps and .pfb fonts; Tesseract loads .gz language data.
          // Cache these same-origin resources only after first use, keeping the initial install small.
          if (response && response.ok && (url.pathname.startsWith('/_next/') || /\.(?:js|mjs|css|png|jpe?g|svg|webp|gif|ico|woff2?|ttf|gz|bcmap|pfb|wasm)$/i.test(url.pathname))) {
            const copy = response.clone();
            activeCacheName().then(name=>caches.open(name)).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached || Response.error());
    })
  );
});
