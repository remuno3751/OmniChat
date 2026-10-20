/* OmniChat service worker: app-shell cache only. Hand written, no dependencies.
 * Never touches: non-GET, cross-origin, requests with Authorization, WebSocket upgrades (/ws),
 * and any API path (/auth /sync /v1 /devices /conversations ...). Only an allow-list is cached:
 *   - navigations (HTML shell)        -> network first, cached copy when offline
 *   - /_expo/static/*, /assets/*      -> content-hashed, cache first
 *   - icons, manifest, favicon        -> stale-while-revalidate
 * Bump VERSION to force a full cache reset.
 */
const VERSION = 'v1';
const CACHE = 'omnichat-shell-' + VERSION;
const SHELL = '/';
const STATIC_RE = /^\/(icons\/|favicon|manifest\.webmanifest$)/;
const HASHED_RE = /^\/(_expo\/static\/|assets\/)/;
const API_RE = /^\/(ws|auth|sync|v1|devices|apikeys|conversations|projects|presets|settings|providers|models|version|ping|healthz|upload|files)(\/|$|\?)/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(SHELL, { cache: 'reload' });
      if (res.ok) {
        await cache.put(SHELL, res.clone());
        const html = await res.text();
        // precache the hashed bundle(s) referenced by the shell so the first offline start works
        const urls = new Set(['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']);
        for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)) {
          if (HASHED_RE.test(m[1]) || STATIC_RE.test(m[1])) urls.add(m[1]);
        }
        await Promise.all([...urls].map((u) => cache.add(u).catch(() => {})));
      }
    } catch (e) { /* offline during install: runtime caching will fill in */ }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('omnichat-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirstShell(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') cache.put(SHELL, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(SHELL);
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const net = fetch(request).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(request, res.clone());
    return res;
  }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('authorization') || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (API_RE.test(path)) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req));
  } else if (HASHED_RE.test(path)) {
    event.respondWith(cacheFirst(req));
  } else if (STATIC_RE.test(path)) {
    event.respondWith(staleWhileRevalidate(req));
  }
  // anything else: browser default (network), not cached
});
