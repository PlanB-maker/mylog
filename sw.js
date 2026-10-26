/* My Log service worker: app works offline; data never touches this cache. */
const VERSION = 'mylog-v5';
const FONT_CACHE = 'mylog-fonts';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function networkFirst(req, cacheKey, timeoutMs) {
  return caches.open(VERSION).then(cache => new Promise(resolve => {
    let settled = false;
    const fallback = () => cache.match(cacheKey).then(r => r || cache.match('./'));
    const timer = setTimeout(() => fallback().then(r => { if (r && !settled) { settled = true; resolve(r); } }), timeoutMs);
    fetch(req).then(res => {
      if (res && res.ok) cache.put(cacheKey, res.clone());
      clearTimeout(timer);
      if (!settled) { settled = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fallback().then(r => { if (!settled) { settled = true; resolve(r || Response.error()); } });
    });
  }));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === 'navigate') { e.respondWith(networkFirst(req, './index.html', 3000)); return; }
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
      return res;
    })));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONT_CACHE).then(cache => cache.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
});
