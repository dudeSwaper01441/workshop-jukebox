// Workshop Jukebox service worker.
// Scope: / (served from /sw.js so it controls every page).
//
// Cache strategy, tuned for this app:
//   * index.html is NOT precached: Vite changes its asset hashes every build,
//     so a cached copy would reference deleted JS/CSS and leave a blank page.
//     HTML is fetched fresh from the network instead.
//   * Immutable app shell (favicon, icons): cache-first, precached on install.
//   * Versioned JS/CSS (Vite hashed filenames): cache-first, cached on demand.
//   * /api/art (image proxy): cache-first — cover art is immutable per URL.
//   * /api/lyrics: cache-first — lyrics for a song never change.
//   * /api/search: cache-first, short-lived — search results are semi-static.
//   * /api/state, /api/request, /api/queue/*, /api/admin/*: network-only.
//     Real-time jukebox state must not be stale-cached; mutations must not
//     silently succeed offline. The app shows a beautiful offline state instead.
//
const CACHE = 'jukebox-v1';
// Only immutable assets are precached. index.html is excluded because its
// referenced asset hashes change on every Vite build.
const SHELL = ['/favicon.svg', '/icons.svg'];
const API_CACHE_PREFIXES = ['/api/lyrics', '/api/search', '/api/art'];
const NETWORK_ONLY_PREFIXES = [
  '/api/state',
  '/api/request',
  '/api/queue/',
  '/api/admin/',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isApiCacheable(url) {
  return API_CACHE_PREFIXES.some((p) => url.pathname.startsWith(p));
}
function isApiNetworkOnly(url) {
  return NETWORK_ONLY_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Same-origin only. Don't touch cross-origin requests (Spotify, etc.).
  if (!url.origin.startsWith(self.location.origin)) return;

  // HTML: always fetch fresh from the network so the page always references
  // the current build's asset hashes. Fall back to cache if offline.
  if (request.mode === 'navigate' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
        }
        return res;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // API routes
  if (url.pathname.startsWith('/api/')) {
    if (isApiNetworkOnly(url)) return; // let it hit the network; app handles failure
    if (isApiCacheable(url)) {
      event.respondWith(
        caches.open(CACHE).then((cache) =>
          cache
            .match(request)
            .then((cached) => {
              if (cached) return cached;
              return fetch(request).then((res) => {
                if (res.ok) {
                  const clone = res.clone();
                  cache.put(request, clone);
                }
                return res;
              });
            })
            .catch(() => {
              // Offline and no cache: return a graceful 503-ish response
              return new Response(
                JSON.stringify({ error: 'offline', offline: true }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
              );
            })
        )
      );
      return;
    }
    // Other API (state, mutations): network only, no SW interference
    return;
  }

  // Static assets: cache-first, populate cache on demand
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res.ok && request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
        }
        return res;
      });
    })
  );
});
