/* PulseCore Service Worker v6.0 */
const CACHE = 'pulsecore-v6';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Network-first for API calls — never intercept
  if (url.pathname.startsWith('/api/') ||
      url.hostname.includes('anthropic.com') ||
      url.hostname.includes('googleapis.com')) {
    return; // let fall through to network
  }

  // Cache-first for static shell
  if (request.method === 'GET') {
    e.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return res;
        }).catch(() => caches.match('/index.html'));
      })
    );
  }
});
