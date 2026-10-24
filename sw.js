// Service Worker: hält alle App-Dateien offline vor.
// WICHTIG: Bei jeder Änderung an der App VERSION erhöhen – sonst bekommen die iPhones das Update nicht.

const VERSION = '1.1.1';
const CACHE = `gerichte-${VERSION}`;

const FILES = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'js/app.js',
  'js/db.js',
  'js/detail.js',
  'js/edit.js',
  'js/icons.js',
  'js/io.js',
  'js/manage.js',
  'js/photo.js',
  'js/pwa.js',
  'js/search.js',
  'js/settings.js',
  'js/store.js',
  'js/ui.js',
  'js/util.js',
];

self.addEventListener('install', event => {
  // cache: 'reload' umgeht den Browser-Cache, damit wirklich die neuen Dateien geladen werden
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'version') event.ports[0]?.postMessage(VERSION);
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') return (await cache.match('index.html')) || fetch(req);
    return (await cache.match(req, { ignoreSearch: true })) || fetch(req);
  })());
});
