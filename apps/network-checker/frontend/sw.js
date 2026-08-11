// Service worker: the dashboard exists to be read during an outage, so the
// shell must paint instantly from cache and the last-known-good report must
// still render with zero network at all. Bump CACHE on any shell file change
// -- that is what forces stale entries out.
const CACHE = "netcheck-shell-v4";
const SHELL = [
  "/", "/index.html", "/manifest.webmanifest",
  "/css/tokens.css", "/css/base.css", "/css/components.css",
  "/js/app.js", "/js/api.js", "/js/store.js", "/js/theme.js", "/js/format.js",
  "/js/charts.js", "/js/export.js", "/js/palette.js", "/js/render.js", "/js/dom.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

/** Serve `/api/data` from cache with an honest marker header -- the page
 * uses it to show "offline" instead of falsely claiming "live" when what's
 * on screen is actually the last-known-good snapshot, not a fresh read. */
async function staleResponse(request) {
  const cached = await caches.match(request);
  if (!cached) return Response.error();
  const headers = new Headers(cached.headers);
  headers.set("X-Netcheck-Cache", "stale");
  return new Response(await cached.blob(), { status: cached.status, headers });
}

/** Write into the cache under `event.waitUntil` -- a fetch handler that
 * merely calls `.then(cache.put)` without extending the event's lifetime
 * can be killed by the browser before the write lands, which is exactly
 * the failure this dashboard cannot afford to have silently. */
function cachePut(event, request, response) {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, response)));
}

// SSE pushes bypass fetch entirely, so the page hands each payload here to
// keep the offline fallback fresh regardless of which transport delivered it.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-data") return;
  const body = JSON.stringify(event.data.payload);
  const response = new Response(body, { headers: { "Content-Type": "application/json" } });
  event.waitUntil(caches.open(CACHE).then((cache) => cache.put("/api/data", response)));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname === "/api/stream") return; // never intercept the live SSE connection

  if (url.pathname === "/api/data") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(event.request);
          cachePut(event, event.request, res.clone());
          return res;
        } catch {
          return staleResponse(event.request);
        }
      })()
    );
    return;
  }

  // Shell assets: cache-first for an instant paint, refreshed in the background.
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      const revalidate = fetch(event.request)
        .then((res) => { cachePut(event, event.request, res.clone()); return res; })
        .catch(() => cached || Response.error());
      if (cached) {
        event.waitUntil(revalidate);
        return cached;
      }
      return revalidate;
    })()
  );
});
