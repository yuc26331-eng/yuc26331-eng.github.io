(function () {
  // Resolve appearance before React paints. Storage denial must never prevent
  // opening a trip. This preference contains no account or travel information.
  var appearanceKey = 'qx-interface-mode';
  // Capture only this script's private handle before account-scoped storage is
  // installed. The single device-wide appearance key never contains trip data.
  var appearanceStorage = null, appearanceSaved = true;
  try { appearanceStorage = window.localStorage; } catch (_) { appearanceSaved = false; }
  var appearanceMedia = window.matchMedia('(max-width: 600px), (max-width: 960px) and (pointer: coarse)');
  function validAppearance(value) { return value === 'pc' || value === 'ios' ? value : 'auto'; }
  function storedAppearance() { try { return appearanceStorage ? validAppearance(appearanceStorage.getItem(appearanceKey)) : 'auto'; } catch (_) { appearanceSaved = false; return 'auto'; } }
  var appearanceMode = storedAppearance();
  function applyAppearance() {
    var root = document.documentElement;
    root.setAttribute('data-interface-mode', appearanceMode);
    root.setAttribute('data-interface-saved', appearanceSaved ? 'true' : 'false');
    root.setAttribute('data-layout', appearanceMode === 'auto' ? (appearanceMedia.matches ? 'ios' : 'pc') : appearanceMode);
    window.dispatchEvent(new Event('qingxing-interface-updated'));
  }
  window.addEventListener('qingxing-interface-mode', function (event) {
    appearanceMode = validAppearance(event.detail);
    try { if (!appearanceStorage) throw new Error('Appearance storage unavailable'); if (appearanceMode === 'auto') appearanceStorage.removeItem(appearanceKey); else appearanceStorage.setItem(appearanceKey, appearanceMode); appearanceSaved = true; } catch (_) { appearanceSaved = false; }
    applyAppearance();
  });
  window.addEventListener('storage', function (event) {
    if (event.key === appearanceKey || event.key === null) { appearanceMode = storedAppearance(); applyAppearance(); }
  });
  if (appearanceMedia.addEventListener) appearanceMedia.addEventListener('change', applyAppearance);
  else appearanceMedia.addListener(applyAppearance);
  applyAppearance();
}());
