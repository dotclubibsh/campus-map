// Lets visitors change their analytics choice from the policy page.
// Uses the same storage key as the map (js/app.js).
(function () {
  var KEY = 'campusMapConsent';
  var state = document.getElementById('consent-state');

  function read() {
    try { return localStorage.getItem(KEY); } catch (err) { return null; }
  }

  function write(value) {
    try { localStorage.setItem(KEY, value); } catch (err) { /* Storage blocked: nothing to remember */ }
  }

  // Google Analytics cookies are set on this host and its parent domain.
  function clearAnalyticsCookies() {
    var hosts = [location.hostname, '.' + location.hostname.split('.').slice(-2).join('.')];
    document.cookie.split(';').forEach(function (cookie) {
      var name = cookie.split('=')[0].trim();
      if (name.indexOf('_ga') !== 0) return;
      hosts.forEach(function (host) {
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=' + host;
      });
      document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    });
  }

  function show() {
    var value = read();
    state.textContent = value === 'granted' ? 'on' : value === 'denied' ? 'off' : 'not set (you have not been asked yet)';
  }

  document.getElementById('consent-allow').addEventListener('click', function () {
    write('granted');
    show();
  });
  document.getElementById('consent-deny').addEventListener('click', function () {
    write('denied');
    clearAnalyticsCookies();
    show();
  });
  show();
})();
