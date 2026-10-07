(function () {
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (search, replacement) {
      if (search instanceof RegExp) return this.replace(search, replacement);
      return this.split(String(search)).join(String(replacement));
    };
  }
  // 仅修复网页代码缓存与 Service Worker：绝不触碰 IndexedDB / localStorage 用户数据。
  // 第一次点击只重新注册离线缓存（不动任何缓存）；仍然打不开时才清理 qingxing-* 静态代码缓存。
  window.__qingxingRepairCache = function () {
    var reload = function () { location.reload(); };
    try {
      if (!('serviceWorker' in navigator) || !window.caches) { reload(); return; }
      var tried = false;
      try { tried = sessionStorage.getItem('qingxing.repairTried') === '1'; } catch (e) { tried = false; }
      if (!tried) {
        try { sessionStorage.setItem('qingxing.repairTried', '1'); } catch (e) { /* 忽略 */ }
        navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(function () {}).then(reload);
        return;
      }
      // 第二次：只清理静态资源缓存（qingxing-*），随后重新注册离线缓存。
      caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (key) { return key.indexOf('qingxing-') === 0; }).map(function (key) { return caches.delete(key); }));
      }).catch(function () {}).then(function () {
        return navigator.serviceWorker.getRegistrations();
      }).then(function (regs) {
        return Promise.all(regs.map(function (reg) { return reg.unregister(); }));
      }).catch(function () {}).then(function () {
        return navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      }).catch(function () {}).then(reload);
    } catch (e) {
      reload();
    }
  };
  window.setTimeout(function () {
    var loading = document.querySelector('[data-app-loading]');
    if (!loading) return;
    loading.innerHTML =
      '<div class="compat-message"><strong>页面没有正常启动</strong>' +
      '<p>这通常是网页离线缓存没有升级完成，不一定是手机系统的问题。本机旅行数据没有丢失。</p>' +
      '<p>先点“重新加载”；如果反复打不开，再点“修复网页缓存”重新注册离线缓存。修复只会清理网页代码缓存，不会删除旅行数据。</p>' +
      '<button type="button" onclick="location.reload()">重新加载</button>' +
      '<button type="button" onclick="window.__qingxingRepairCache&&window.__qingxingRepairCache()">修复网页缓存</button></div>';
  }, 12000);
}());