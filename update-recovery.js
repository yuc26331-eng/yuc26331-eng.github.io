// This small foreground updater never opens a user database or changes localStorage.
'use strict';
const statusNode=document.getElementById('status'),diagnosticNode=document.getElementById('diagnostic'),button=document.getElementById('retry');
let target=null,lastFailure=null,startedAt=0;
function cleanResponse(bytes,response){
  const headers=new Headers(response.headers);
  for(const name of ['content-encoding','content-length','transfer-encoding','set-cookie'])headers.delete(name);
  return new Response(bytes,{status:response.status,statusText:response.statusText,headers});
}
function describe(error,detail={}){const value=new Error(String(error));value.diagnostic={version:target?.sw,time:new Date().toISOString(),...detail,errorType:error?.name||'Error',underlying:String(error)};return value;}
async function reportFailure(failure){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
  try{await fetch('/api/update-diagnostic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(failure),credentials:'same-origin',signal:controller.signal});}catch{}finally{clearTimeout(timer);}
}
function showFailure(failure){
  if(!failure||target&&failure.version!==target.sw||startedAt&&Date.parse(failure.time)<startedAt)return;
  lastFailure=failure;diagnosticNode.textContent=JSON.stringify(failure,null,2);document.getElementById('details').open=true;
  caches.open('qx-update-diagnostics').then(cache=>cache.put('/last-failure',new Response(JSON.stringify(failure),{headers:{'Content-Type':'application/json'}}))).catch(()=>{});
}
async function readFailure(){try{if(await caches.has('qx-update-diagnostics')){const response=await(await caches.open('qx-update-diagnostics')).match('/last-failure');if(response)showFailure(await response.json());}}catch{}}
navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='QX_UPDATE_FAILURE')showFailure(event.data.diagnostic);});
async function download(url,timeout=20000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch(url,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    if(!response.ok)throw describe(new Error('HTTP '+response.status),{url:new URL(url,location.origin).href,phase:'download',status:response.status});
    const bytes=await response.arrayBuffer();return cleanResponse(bytes,response);
  }finally{clearTimeout(timer);}
}
async function publicDownload(bridge,path,timeout){
  try{return await download(bridge,timeout);}catch(error){
    if(![404,405,501].includes(error.diagnostic?.status))throw error;
    return download(path+(path.includes('?')?'&':'?')+'qx_release='+encodeURIComponent(target.sw),timeout);
  }
}
async function readTarget(){
  const response=await download('/version.json?t='+Date.now());const info=await response.json();
  if(!/^\d+\.\d+\.\d+$/.test(info.version)||!/^qingxing-v\d+$/.test(info.sw)||!/^[-.\w]{1,100}$/.test(info.build))throw new Error('版本清单无效');
  return info;
}
async function digest(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');}
async function matches(response,row){if(!response?.ok)return false;try{const bytes=await response.arrayBuffer();return bytes.byteLength===row.size&&await digest(bytes)===row.sha256;}catch{return false;}}
async function prepareCore(){
  let manifest;try{manifest=await(await publicDownload('/api/update-manifest?sw='+encodeURIComponent(target.sw),'/offline-resources.json')).json();}catch(error){throw describe(error,{...error.diagnostic,path:'/offline-resources.json'});}
  if(manifest.format!=='qingxing-offline-resources-v1'||manifest.sw!==target.sw||manifest.build!==target.build||!Array.isArray(manifest.core)||!Array.isArray(manifest.resources))throw describe(new Error('版本与资源清单不一致'),{phase:'manifest',path:'/offline-resources.json'});
  const records=new Map(manifest.resources.map(row=>[row.path,row]));
  const mandatory=['/index.html','/tools/index.html','/translator/index.html','/print/index.html','/help/index.html','/compat.js','/interface.js','/offline.html','/manifest.webmanifest','/favicon.svg','/icons/icon-192.png','/icons/icon-512.png','/icons/apple-touch-icon.png','/covers/dali.jpg','/covers/hangzhou.jpg','/covers/kyoto.jpg'];
  if(mandatory.some(path=>!manifest.core.includes(path)))throw describe(new Error('核心清单缺少启动文件'),{phase:'manifest',path:'/offline-resources.json'});
  for(const path of manifest.core){const row=records.get(path);if(!/^\/(?!\/)[^?#]*$/.test(path)||path.includes('..')||!row||!Number.isSafeInteger(row.size)||row.size<0||!/^[a-f0-9]{64}$/.test(row.sha256))throw describe(new Error('核心资源记录无效'),{phase:'manifest',path});}
  // A new worker may already be installed under the old page's registration URL.
  // Verify and use that release in place before allocating any foreground stage.
  try{
    const stateResponse=await(await caches.open('qingxing-cache-state')).match('/active-cache');
    const state=stateResponse?await stateResponse.json():null;
    if(state?.version===target.sw&&typeof state.active==='string'&&(state.active===target.sw||state.active.startsWith('qx-static-'+target.sw+'-repair-')||state.active.startsWith(target.sw+'-repair-'))&&await caches.has(state.active)){
      const existing=await caches.open(state.active);let complete=true;
      for(const path of manifest.core)if(!await matches(await existing.match(path),records.get(path))){complete=false;break;}
      if(complete)return state.active;
    }
  }catch{}
  const name='qx-static-'+target.sw+'-repair-window-'+target.build;
  let cache;try{cache=await caches.open(name);}catch(error){throw describe(error,{phase:'cache-open',path:'/offline-resources.json'});}
  let next=0,done=0,failed=false;
  const runners=[0,1].map(async()=>{
    while(!failed&&next<manifest.core.length){
      const path=manifest.core[next++],row=records.get(path);
      try{
        let hit;try{hit=await cache.match(path);}catch{}
        if(!await matches(hit,row)){
          const url='/api/update-resource?sw='+encodeURIComponent(target.sw)+'&path='+encodeURIComponent(path)+'&sha256='+row.sha256;
          let response,detail;
          for(let attempt=1;attempt<=2;attempt++){
            detail={path,url:new URL(url,location.origin).href,phase:'download',attempt};
            try{
              response=await publicDownload(url,path,attempt===1?20000:35000);
              detail.status=response.status;detail.contentType=response.headers.get('content-type');detail.phase='read-body';
              const bytes=await response.arrayBuffer();detail.actualSize=bytes.byteLength;detail.expectedSize=row.size;detail.phase='verify-size';
              if(bytes.byteLength!==row.size)throw new Error('Size mismatch');
              detail.phase='verify-sha256';detail.expectedHash=row.sha256;detail.actualHash=await digest(bytes);
              if(detail.actualHash!==row.sha256)throw new Error('SHA-256 mismatch');
              response=cleanResponse(bytes,response);break;
            }catch(error){if(attempt===2)throw describe(error,{...detail,...error.diagnostic,path});}
          }
          try{await cache.put(path,response);}catch(error){throw describe(error,{...detail,phase:'cache-write',path});}
        }
        done++;statusNode.textContent='正在校验并保存新版核心资源 '+done+'/'+manifest.core.length+'：'+path;
      }catch(error){failed=true;throw error;}
    }
  });
  const completed=await Promise.allSettled(runners),failure=completed.find(result=>result.status==='rejected');if(failure)throw failure.reason;
  for(const path of manifest.core)if(!await matches(await cache.match(path),records.get(path)))throw describe(new Error('已保存的资源未通过复核'),{path,phase:'verify-cache'});
  await cache.put('/offline-resources.json',new Response(JSON.stringify(manifest),{headers:{'Content-Type':'application/json'}}));
  return name;
}
function appWorker(worker){try{const url=new URL(worker.scriptURL);return url.origin===location.origin&&url.pathname==='/sw.js';}catch{return false;}}
function verify(worker){return new Promise((resolve,reject)=>{
  const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(new Error('缓存程序版本核对超时'));},10000);
  channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();event.data?.ok&&event.data.version===target.sw?resolve():reject(new Error(event.data?.error||'核心资源验证未通过'));};
  try{worker.postMessage({type:'VERIFY_CACHE'},[channel.port2]);}catch(error){clearTimeout(timer);channel.port1.close();channel.port2.close();reject(error);}
});}
// Safari can expose a live registration before acknowledging register().
// The version in a cached page's script URL may also differ from its contents.
async function installTarget(){
  let registration=null,registrationError=null,started=false,sawCandidate=false;
  const began=Date.now(),proofs=new WeakMap(),activationRequested=new WeakSet(),awaitingActivation=new WeakSet();
  async function prove(worker){
    if(!appWorker(worker)||!['installed','activating','activated'].includes(worker.state))return false;
    if(!proofs.has(worker))proofs.set(worker,verify(worker).then(()=>true,()=>false));
    return proofs.get(worker);
  }
  async function inspectRegistration(){
    if(typeof navigator.serviceWorker.getRegistration!=='function')return;
    let timer;
    try{const current=await Promise.race([navigator.serviceWorker.getRegistration('/'),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1500);})]);if(current)registration=current;}catch{}finally{clearTimeout(timer);}
  }
  while(Date.now()-began<(sawCandidate?120000:45000)){
    await inspectRegistration();
    for(const worker of [registration?.active,navigator.serviceWorker.controller])if(worker?.state==='activated'&&await prove(worker))return {worker,prove};
    const waiting=registration?.waiting;
    if(appWorker(waiting)&&waiting.state==='installed'&&!activationRequested.has(waiting)){
      activationRequested.add(waiting);
      if(await prove(waiting)){awaitingActivation.add(waiting);waiting.postMessage({type:'SKIP_WAITING',version:target.sw});await new Promise(resolve=>setTimeout(resolve,250));continue;}
    }
    const pending=[registration?.installing,registration?.waiting].filter(worker=>appWorker(worker)&&worker.state!=='redundant'&&!(worker.state==='installed'&&activationRequested.has(worker)&&!awaitingActivation.has(worker)));
    if(pending.length){sawCandidate=true;statusNode.textContent='已发现缓存程序正在安装，继续核对实际版本；不会重复发起注册…';}
    else if(!started){
      started=true;
      // Observe the native job separately: a pending promise is not evidence
      // that no worker has installed or activated.
      Promise.resolve().then(()=>navigator.serviceWorker.register('/sw.js?v='+encodeURIComponent(target.sw),{scope:'/',updateViaCache:'none'})).then(value=>{registration=value;},error=>{registrationError=error;});
    }
    if(registrationError&&!pending.length)throw registrationError;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error(sawCandidate?'缓存程序仍未完成安装；已校验资源与原资料保留，可安全重试。':'未观察到可验证的新版缓存程序；注册等待超时，原资料保留。');
}
async function verifiedController(prove){
  const began=Date.now();
  while(Date.now()-began<60000){if(await prove(navigator.serviceWorker.controller))return;await new Promise(resolve=>setTimeout(resolve,250));}
  throw new Error('新版已验证，Safari尚未完成页面接管；原资料保留，可安全重试。');
}
button.addEventListener('click',async()=>{
  button.disabled=true;lastFailure=null;startedAt=Date.now();
  try{
    if(!navigator.serviceWorker||!window.caches)throw new Error('当前浏览器无法使用安全离线安装；请保留此页面的诊断。');
    target=await readTarget();document.getElementById('version').textContent='正在升级到 v'+target.version+' · Build '+target.build;
    statusNode.textContent='正在前台下载并校验新版资源；原版本与旅行数据继续保留…';
    await prepareCore();
    statusNode.textContent='全部核心资源已校验，正在安装并切换新版…';
    const installed=await installTarget();
    statusNode.textContent='新版内容与核心资源已验证，正在确认页面接管…';
    await verifiedController(installed.prove);
    sessionStorage.setItem('qingxing.updated',JSON.stringify({version:target.version,build:target.build,sw:target.sw}));
    location.replace('/tools/?v='+encodeURIComponent(target.build)+'#update');
  }catch(error){
    const failure=error.diagnostic||{version:target?.sw,time:new Date().toISOString(),phase:'activate',errorType:error?.name||'Error',underlying:String(error)};
    try{const estimate=await navigator.storage?.estimate();if(estimate)Object.assign(failure,{usage:estimate.usage,quota:estimate.quota});}catch{}
    showFailure(failure);await reportFailure(failure);await readFailure();
    statusNode.textContent=failure.errorType==='QuotaExceededError'?'浏览器拒绝写入新版缓存（存储配额不足）；旧版本和旅行资料保持不变。':'更新未完成；原版本与旅行资料保持不变。下方显示失败文件和阶段，可安全重试。';
    button.disabled=false;
  }
});
(async()=>{try{target=await readTarget();document.getElementById('version').textContent='线上最新版：v'+target.version+' · Build '+target.build;button.disabled=false;if(['/upgrade-v2','/upgrade-v2/','/upgrade-v2.html'].includes(location.pathname))button.click();else await readFailure();}catch(error){statusNode.textContent=String(error);button.disabled=false;}})();
