const CACHE_NAME = 'leadcheck-app-shell-v2026-07-22-progress-bars';
const APP_SHELL = [
  '/styles.css',
  '/branding.js',
  '/auth.js',
  '/database.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.error('[LeadCheck SW] Install cache failed:', err);
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .catch(err => {
        console.error('[LeadCheck SW] Activate cleanup failed:', err);
      })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  const networkOnlyPaths = new Set([
    '/api/analyze',
    '/api/auth-config',
    '/api/billing/config',
    '/api/billing/subscription',
    '/styles.css',
    '/branding.js',
    '/auth.js',
    '/database.js',
  ]);

  if (networkOnlyPaths.has(url.pathname) || url.pathname.startsWith('/api/reports/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});
