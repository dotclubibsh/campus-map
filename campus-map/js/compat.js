// Runs before the map. Very old browsers (before 2023: iOS 16.3 and older, Chrome 88
// and older) cannot load the map's code, so tell them plainly instead of showing a blank screen.
(function () {
  var supportsImportMaps = typeof HTMLScriptElement !== 'undefined' &&
    typeof HTMLScriptElement.supports === 'function' && HTMLScriptElement.supports('importmap');
  if (supportsImportMaps) return;

  function show() {
    var box = document.getElementById('fatal-error');
    if (!box) return;
    document.getElementById('fatal-title').textContent = 'Your browser needs an update';
    document.getElementById('fatal-message').textContent =
      'Campus Connect needs a browser from 2023 or later. Update your phone, or open this page in the latest Chrome, Safari, Edge or Firefox.';
    var retry = document.getElementById('btn-fatal-retry');
    if (retry) retry.textContent = 'Check again';
    if (retry) retry.addEventListener('click', function () { location.reload(); });
    box.hidden = false;
    var loader = document.getElementById('loading-screen');
    if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
