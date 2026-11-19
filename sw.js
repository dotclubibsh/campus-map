// Service worker: lets the map open offline once it has been visited.
// Raise VERSION whenever files listed in SHELL_FILES change.
const VERSION = 'v7';
const SHELL_CACHE = `campus-map-shell-${VERSION}`;
const RUNTIME_CACHE = `campus-map-runtime-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './legal.html',
  './js/app.js?v=8',
  './js/navigation.js?v=5',
  './js/legal.js',
  './js/compat.js',
  './manifest.webmanifest',
  './data/locations.json',
  './data/paths.json',
  './data/campus-shell.json',
  './assets/academic-roof.jpg',
  './assets/dot.png',
  './assets/logo-stroke-small.png',
  './assets/icon-192.png',
  './assets/favicon-32.png',
];

// Pinned library versions never change, so they are safe to keep.
const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'www.gstatic.com'];
// Analytics must never be cached or replayed.
const NEVER_CACHE_HOSTS = ['www.googletagmanager.com', 'www.google-analytics.com', 'region1.google-analytics.com', 'analytics.google.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('campus-map-') && !keep.has(name)).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// The page asks for this after the visitor taps "Refresh" on the update notice.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await caches.match(request);
  const refresh = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    refresh.catch(() => {}); // Offline: the cached copy is already on its way
    return cached;
  }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (NEVER_CACHE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith('.google-analytics.com'))) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

  if (url.origin === self.location.origin) {
    // Map data changes as paths get traced, so always try for the newest copy.
    if (url.pathname.includes('/data/')) {
      event.respondWith(networkFirst(request));
    } else {
      event.respondWith(staleWhileRevalidate(request));
    }
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
});
