/*
 * Larder's service worker: keeps the web app on this device so it opens with
 * no connection, where it offers the copies saved on the device (see
 * docs/DECISIONS.md, "Offline copies"). vite.config.ts writes it into
 * dist/web as sw.js, with the build's files and a version that changes
 * whenever any of them does.
 *
 * It only ever answers for the app's own files. The API, photos, MCP and
 * sign-in pages always go to the network: data comes from saved copies.
 */
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = `larder-app-${VERSION}`;
const scope = new URL(self.registration.scope);
const INDEX = new URL('./', scope).href;
const KEPT = new Set(FILES.map((f) => new URL(f, scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(new URL(f, scope), { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('larder-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * The app's page: from the network when it answers (so updates arrive), else
 * the kept one. Only the kept one is ever used offline, so the page and the
 * files it loads are always from the same build.
 */
async function page(request) {
  const kept = () => caches.open(CACHE).then((cache) => cache.match(INDEX));
  try {
    const res = await Promise.race([
      fetch(request),
      // A connection that hangs (a tunnel to a house with no internet) counts as none.
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
    ]);
    // Larder isn't there, but something in between answered (a proxy's error page).
    if (res.status >= 500) return (await kept()) ?? res;
    return res;
  } catch {
    return (await kept()) ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  if (request.mode === 'navigate' && (url.href === INDEX || url.href === `${INDEX}index.html`)) {
    event.respondWith(page(request));
  } else if (KEPT.has(url.href)) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(url.href)).then((hit) => hit ?? fetch(request)));
  }
});
