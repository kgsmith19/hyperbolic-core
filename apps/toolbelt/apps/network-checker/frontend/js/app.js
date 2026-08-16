import { createStore } from "./store.js";
import { connectLive, cacheForOffline } from "./api.js";
import { cycleTheme, currentTheme } from "./theme.js";
import { exportJson, exportCsv } from "./export.js";
import { initPalette } from "./palette.js";
import { renderPills, renderCauses, renderErrors, renderSamples, renderEnv, renderChart } from "./render.js";
import { humanize } from "./format.js";

const $ = (id) => document.getElementById(id);

const store = createStore({ samples: [], errors: [], bursts: [], causes: [], scan: {}, live: null });
let expandedCause = null;
let lastCulprit = undefined;

function withTransition(fn) {
  if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(fn);
  } else {
    fn();
  }
}

function render() {
  const d = store.get();
  withTransition(() => {
    renderPills($("pills"), d.live);
    renderCauses($("causes-list"), d.causes, d.samples, expandedCause, (cause) => {
      expandedCause = expandedCause === cause ? null : cause;
      render();
    });
    renderErrors($("errors-table"), d.errors);
    renderSamples($("samples-table"), d.samples);
    renderEnv($("env-table"), d.scan);
    renderChart($("latency-chart"), $("latency-tooltip"), d.samples,
      [{ key: "gw_ms", label: "gateway", color: "var(--ok)" },
       { key: "inet_ms", label: "internet", color: "var(--accent)" },
       { key: "tls_ms", label: "TLS", color: "var(--warn)" }],
      { floor: 50, bandPredicate: (r) => Boolean(r.culprit) });
    renderChart($("loss-chart"), $("loss-tooltip"), d.samples,
      [{ key: "gw_loss", label: "gateway loss %", color: "var(--ok)" },
       { key: "inet_loss", label: "internet loss %", color: "var(--accent)" }],
      { floor: 10 });
  });

  $("subtitle").textContent = !d.live ? "no data yet"
    : d.live.culprit ? `last sample blamed: ${humanize(d.live.culprit)}` : "last sample healthy";
  const bursts = d.bursts || [];
  $("burst-note").textContent = bursts.length ? `— ${d.errors.length} errors in ${bursts.length} bursts` : "";
  $("sample-count").textContent = `${d.samples?.length || 0} samples`;

  const culprit = d.live?.culprit ?? null;
  if (culprit !== lastCulprit) {
    lastCulprit = culprit;
    $("live-region").textContent = culprit
      ? `Layer status changed: ${humanize(culprit)} is the likely cause.`
      : "Layer status changed: all layers healthy.";
  }
}

store.subscribe(render);

function setStatus(state) {
  const node = $("status");
  node.dataset.state = state;
  node.querySelector("span:last-child").textContent =
    state === "live" ? "live" : state === "reconnecting" ? "reconnecting…" : "offline";
}

const live = connectLive({ onData: (data) => store.set(data), onStatus: setStatus });

$("btn-refresh").addEventListener("click", live.refresh);
$("btn-export-json").addEventListener("click", () => exportJson(store.get()));
$("btn-export-csv").addEventListener("click", () => exportCsv(store.get().samples));
$("btn-print").addEventListener("click", () => window.print());
$("btn-theme").addEventListener("click", () => { $("btn-theme").textContent = themeLabel(cycleTheme()); });

function themeLabel(theme) {
  return { system: "theme: system", light: "theme: light", dark: "theme: dark" }[theme];
}
$("btn-theme").textContent = themeLabel(currentTheme());

const palette = initPalette($("palette"), $("palette-input"), $("palette-list"), [
  { title: "Refresh now", hint: "r", run: live.refresh },
  { title: "Export JSON", hint: "e", run: () => exportJson(store.get()) },
  { title: "Export CSV", hint: "c", run: () => exportCsv(store.get().samples) },
  { title: "Print / save PDF", hint: "p", run: () => window.print() },
  { title: "Cycle theme", hint: "t", run: () => $("btn-theme").click() },
  { title: "Keyboard shortcuts", hint: "?", run: () => $("shortcuts").showModal() },
]);
$("btn-palette").addEventListener("click", palette.open);

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette.open(); return; }
  if (typing || document.querySelector("dialog[open]")) return;
  if (e.key === "r") live.refresh();
  else if (e.key === "e") exportJson(store.get());
  else if (e.key === "c") exportCsv(store.get().samples);
  else if (e.key === "p") window.print();
  else if (e.key === "t") $("btn-theme").click();
  else if (e.key === "?") $("shortcuts").showModal();
});

$("shortcuts").addEventListener("click", (e) => { if (e.target === $("shortcuts")) $("shortcuts").close(); });
$("shortcuts-close").addEventListener("click", () => $("shortcuts").close());

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  // The SW may not yet control this page when the first poll/SSE payload
  // arrives (install/activate/claim all take a beat); once it does, hand it
  // whatever is already in the store so the offline fallback isn't empty
  // for however long it takes the next real update to land.
  navigator.serviceWorker.addEventListener("controllerchange", () => cacheForOffline(store.get()));
}
