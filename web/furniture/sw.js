// RoomFit service worker: keeps the app working offline once it has been opened.
const CACHE = 'roomfit-v2';
const SHELL = ['./', 'app.js', 'furniture.js', 'manifest.webmanifest', 'vendor/three.module.min.js',
  'vendor/RoundedBoxGeometry.js', 'vendor/RoomEnvironment.js', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('roomfit-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first so updates arrive; the cached copy when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request)
    .then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request.mode === 'navigate' ? './' : e.request, copy)); }
      return r;
    })
    .catch(() => caches.match(e.request.mode === 'navigate' ? './' : e.request)));
});
