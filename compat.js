(function () {
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (search, replacement) {
      if (search instanceof RegExp) return this.replace(search, replacement);
      return this.split(String(search)).join(String(replacement));
    };
  }
  window.setTimeout(function () {
    var loading = document.querySelector('[data-app-loading]');
    if (!loading) return;
    loading.innerHTML =
      '<div class="compat-message"><strong>页面没有正常启动</strong>' +
      '<p>请更新 iPhone 系统后，用 Safari 重新打开。也可以先清除本网站数据再重试。</p>' +
      '<button type="button" onclick="location.reload()">重新加载</button></div>';
  }, 12000);
}());
