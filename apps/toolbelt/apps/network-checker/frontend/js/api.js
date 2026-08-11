// Live data over Server-Sent Events, with a polling fallback for browsers
// (or proxies) that won't hold a streaming connection open. SSE means a new
// sample shows up within about a second of being written, instead of
// waiting out a fixed poll interval — and the connection itself becomes a
// signal: its state *is* whether the dashboard's view is current.
const POLL_MS = 5000;
const OFFLINE_AFTER = 3;

/** SSE pushes never pass through a `fetch("/api/data")` call, so the service
 * worker's own cache-on-fetch logic never sees them -- the last-known-good
 * snapshot would silently go stale the moment SSE takes over from the
 * initial poll. Handing each payload to the SW over postMessage keeps the
 * offline fallback current regardless of which transport delivered it. */
export function cacheForOffline(data) {
  navigator.serviceWorker?.controller?.postMessage({ type: "cache-data", payload: data });
}

export function connectLive({ onData, onStatus }) {
  let es = null;
  let pollHandle = null;
  let consecutiveErrors = 0;

  async function pollOnce() {
    try {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      onData(data);
      // The service worker sets this when the network was unreachable and it
      // fell back to the last cached response -- that is not "live".
      if (res.headers.get("X-Netcheck-Cache")) onStatus("offline");
      else { onStatus("live"); cacheForOffline(data); }
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors += 1;
      onStatus(consecutiveErrors >= OFFLINE_AFTER ? "offline" : "reconnecting");
    }
  }

  function startPolling() {
    if (es) { es.close(); es = null; }
    if (pollHandle) return;
    pollOnce();
    pollHandle = setInterval(pollOnce, POLL_MS);
  }

  function startSSE() {
    if (typeof EventSource === "undefined") return startPolling();
    es = new EventSource("/api/stream");
    es.addEventListener("data", (event) => {
      try {
        const data = JSON.parse(event.data);
        onData(data);
        onStatus("live");
        cacheForOffline(data);
      } catch {
        /* malformed frame; wait for the next one rather than tearing down */
      }
    });
    es.onopen = () => onStatus("live");
    es.onerror = () => {
      onStatus("reconnecting");
      startPolling();
    };
  }

  // Paint something immediately rather than waiting on the first SSE frame.
  pollOnce();
  startSSE();

  return {
    refresh: pollOnce,
    stop() {
      if (es) es.close();
      if (pollHandle) clearInterval(pollHandle);
    },
  };
}
