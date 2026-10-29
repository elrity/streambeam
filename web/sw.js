// StreamBeam service worker: keeps the app shell available offline.
// Live data (/gemini, /vlc) and other sites' media always go to the network.
const CACHE = 'streambeam-v1';
const SHELL = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/\/(gemini|vlc)(\/|$)/.test(url.pathname)) return;

  // Pages: network first so updates arrive, cached shell when offline (shortcut URLs carry ?go=).
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request)
      .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./', copy)); } return r; })
      .catch(() => caches.match('./')));
    return;
  }
  // Icons and manifest: cache first, refreshed in the background.
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; });
    return hit || net;
  }));
});
