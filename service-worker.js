/* Virtual Pike — minimal service worker (offline app shell) */
const CACHE_VERSION = 'pike-v17';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './styles/tokens.css',
  './styles/base.css',
  './styles/components.css',
  './styles/sidebar.css',
  './styles/today.css',
  './styles/auth.css',
  './js/auth.js',
  './js/state.js',
  './js/router.js',
  './js/db.js',
  './js/modal.js',
  './js/recurrence.js',
  './js/today.js',
  './js/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept Supabase or weather API requests
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in') || url.hostname.includes('open-meteo')) {
    return;
  }

  // Network-first: always try the network, fall back to cache offline.
  // Successful same-origin responses are cached so the app still loads
  // when the user is offline.
  event.respondWith(
    fetch(req).then((response) => {
      if (response.ok && url.origin === self.location.origin) {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(req))
  );
});
