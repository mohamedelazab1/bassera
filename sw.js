// Offline support: the app shell is served network-first (updates arrive as soon
// as there is a connection); the pinned CDN libraries and the object-detection
// model are cache-first (their URLs carry exact versions, so they never change).
const CACHE = 'bassera-v2';
const IMMUTABLE = (url) =>
  url.hostname === 'cdn.jsdelivr.net' ||
  (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/tfjs-models/'));
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/protocol.js', 'js/device.js', 'js/camera.js', 'js/vision.js', 'js/speech.js',
  'js/training.js', 'js/sos.js', 'js/radar.js', 'js/settings-ui.js', 'js/store.js',
  'icons/favicon-64.png', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'img/bassera-wordmark.png', 'img/eyeon-mark.png', 'img/eyeon-logo.png',
  'fonts/tajawal.css', 'fonts/tajawal-400-arabic.woff2', 'fonts/tajawal-400-latin.woff2',
  'fonts/tajawal-500-arabic.woff2', 'fonts/tajawal-500-latin.woff2', 'fonts/tajawal-700-arabic.woff2',
  'fonts/tajawal-700-latin.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Never let an error page (404, 500...) replace a good cached copy.
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html'))),
    );
  } else if (IMMUTABLE(url)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })),
    );
  }
});
