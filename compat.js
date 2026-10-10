(function () {
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (search, replacement) {
      if (search instanceof RegExp) return this.replace(search, replacement);
      return this.split(String(search)).join(String(replacement));
    };
  }
  function bounded(promise, milliseconds) {
    return new Promise(function (resolve, reject) {
      var timer = window.setTimeout(function () { reject(new Error('cache verification timeout')); }, milliseconds);
      promise.then(function (value) { window.clearTimeout(timer); resolve(value); }, function (error) { window.clearTimeout(timer); reject(error); });
    });
  }
  // React owns the loading markup. Never replace it before hydration.
  // The app provides its own loading/retry UI after React has started.
  window.__qingxingRepairCache = function () {
    if (!('serviceWorker' in navigator) || !window.MessageChannel) { window.location.reload(); return Promise.resolve(); }
    return bounded(Promise.resolve().then(function () { return navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }); }), 30000).then(function (registration) {
      return bounded(registration.update(), 30000).then(function () {
        return new Promise(function (resolve, reject) {
          var interval, timer;
          function check() {
            if (!registration.installing && !registration.waiting && registration.active && registration.active.state === 'activated') {
              window.clearInterval(interval); window.clearTimeout(timer); resolve(registration.active);
            }
          }
          interval = window.setInterval(check, 250);
          timer = window.setTimeout(function () { window.clearInterval(interval); reject(new Error('worker activation timeout')); }, 90000);
          check();
        });
      });
    }).then(function (worker) {
      return new Promise(function (resolve, reject) {
        var channel = new window.MessageChannel();
        var timer = window.setTimeout(function () { channel.port1.close(); reject(new Error('worker verification timeout')); }, 90000);
        channel.port1.onmessage = function (event) {
          window.clearTimeout(timer); channel.port1.close();
          var data = event.data;
          if (data && data.ok === true && /^qingxing-v\d+$/.test(data.version)) resolve();
          else reject(new Error('cache verification failed'));
        };
        try { worker.postMessage({ type: 'REPAIR_CACHE' }, [channel.port2]); }
        catch (error) { window.clearTimeout(timer); channel.port1.close(); reject(error); }
      });
    }).then(function () { window.location.reload(); }).catch(function () {
      window.alert('缓存校验未完成，现有缓存和旅行数据已保留。请在网络恢复后重试。');
    });
  };
}());
