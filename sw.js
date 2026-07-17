/* Stage Ready — service worker (offline app shell + runtime cache) */
const VERSION = 'stage-ready-v14';
const CORE = [
  './',
  './index.html',
  './css/app.css',
  './vendor/jszip.min.js',
  './js/01-core.js',
  './js/02-library.js',
  './js/03-setlists.js',
  './js/04-player.js',
  './js/05-details.js',
  './js/06-tools.js',
  './js/07-data.js',
  './js/08-app.js',
  './js/09-sync.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    // cache:'reload' bypasses the browser HTTP cache — otherwise a version
    // bump can precache STALE assets the page just loaded, freezing the old
    // app into the new cache forever.
    caches.open(VERSION)
      .then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Navigation requests: network-first, fall back to cached shell (offline).
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else (app assets, fonts): cache-first, then network,
  // caching successful responses for offline use.
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
    })
  );
});

/* ---------------- background sync ----------------
   The sync engine is DOM-free, so it can run here with no page open.
   Chrome/Android only: Safari/iOS implements neither Background Sync nor
   Periodic Background Sync, so there the app syncs while it is open. */
try{
  importScripts('./js/09-sync.js');
  self.addEventListener('sync', (e) => {
    if (e.tag === 'sr-sync') e.waitUntil(runSync(false).catch(() => {}));
  });
  self.addEventListener('periodicsync', (e) => {
    if (e.tag === 'sr-periodic') e.waitUntil(runSync(false).catch(() => {}));
  });
}catch(err){
  // never let a sync problem break offline caching
  console.warn('sync engine unavailable in SW:', err);
}
