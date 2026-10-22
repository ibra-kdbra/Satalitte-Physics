// Service worker: repeat visits load the large files from the browser's cache,
// and the app still opens offline.
//   assets/, vendor/  cache first. They only change when the textures or the
//                     libraries change; ASSET_VERSION is a hash of them, stamped
//                     at deploy (.github/workflows/pages.yml), and a new version
//                     drops the old cache.
//   everything else   network first (code, page, satellite data stay fresh),
//                     cached copy when offline.
// Only same-origin GET requests are handled (live CelesTrak requests pass through).
const ASSET_VERSION = 'dev';
const ASSETS = `satalitte-assets-${ASSET_VERSION}`;
const APP = 'satalitte-app';
const LONG_LIVED = /\/(assets|vendor)\//;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('satalitte-assets-') && key !== ASSETS) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(LONG_LIVED.test(url.pathname) ? cacheFirst(req) : networkFirst(req));
});

// The page registers the worker after it has loaded, so it sends the URLs it
// already fetched; they are stored now (mostly from the HTTP cache) and the
// second visit is served from here too.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'warm' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(Promise.all(event.data.urls.map(async (u) => {
    const url = new URL(u, self.location.href);
    if (url.origin !== self.location.origin) return;
    const cache = await caches.open(LONG_LIVED.test(url.pathname) ? ASSETS : APP);
    if (await cache.match(url.href, { ignoreSearch: true })) return;
    try {
      const res = await fetch(url.href);
      if (res.ok) await cache.put(url.href, res);
    } catch { /* offline or gone: skip */ }
  })));
});

async function cacheFirst(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(APP);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    throw err;
  }
}
