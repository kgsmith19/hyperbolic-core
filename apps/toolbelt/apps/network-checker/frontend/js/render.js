import { el, replaceChildren } from "./dom.js";
import { ms, when, label, tone, humanize } from "./format.js";
import { buildChart, polyline, bandsPath, nearestIndex } from "./charts.js";

export const LAYERS = [
  { key: "gw_state", ms: "gw_ms", label: "LAN / Wi-Fi" },
  { key: "hop_state", ms: "hop_ms", label: "ISP hop" },
  { key: "inet_state", ms: "inet_ms", label: "Internet" },
  { key: "dns_router_state", ms: "dns_router_ms", label: "Router DNS" },
  { key: "dns_public_state", ms: "dns_public_ms", label: "Public DNS" },
  { key: "tls_state", ms: "tls_ms", label: "TLS target" },
];

export function renderPills(node, live) {
  replaceChildren(node, LAYERS.map((layer) => el("div", { class: `pill ${tone(live?.[layer.key])}` }, [
    el("span", { text: layer.label }),
    el("b", { text: label(live?.[layer.key]) }),
    el("span", { text: ms(live?.[layer.ms]) }),
  ])));
}

function evidenceTable(samples, cause) {
  const matching = samples.filter((s) => s.culprit === cause).slice(0, 20);
  if (!matching.length) {
    return el("p", { class: "empty", text: "No individual samples carry this cause (it's summarized from LLM error bursts, not per-row culprits)." });
  }
  const rows = matching.map((s) => el("tr", {}, [
    el("td", { text: when(s.ts) }), el("td", { text: ms(s.gw_ms) }),
    el("td", { text: ms(s.inet_ms) }), el("td", { text: ms(s.dns_router_ms) }), el("td", { text: ms(s.tls_ms) }),
  ]));
  return el("table", {}, [
    el("thead", {}, [el("tr", {}, ["when", "gw", "inet", "dns", "tls"].map((h) => el("th", { text: h })))]),
    el("tbody", {}, rows),
  ]);
}

export function renderCauses(node, causes, samples, expanded, onToggle) {
  if (!causes?.length) {
    replaceChildren(node, [el("p", { class: "empty", text: "Nothing identified yet — that is a good sign, but it also means nothing has been caught in the act. Leave network-checker watch running so the next failure lands beside a measured sample." })]);
    return;
  }
  replaceChildren(node, causes.map((c) => {
    const isOpen = expanded === c.cause;
    const card = el("div", { class: "cause", role: "button", tabindex: "0", "aria-expanded": String(isOpen) }, [
      el("h3", {}, [
        el("span", { text: humanize(c.cause) }),
        el("span", { class: `tag ${c.confidence}`, text: c.confidence }),
        el("span", { class: "hint", text: isOpen ? "hide samples ▲" : "view evidence ▼" }),
      ]),
      el("p", { text: c.evidence }),
      el("p", { class: "fix", text: c.fix }),
    ]);
    if (isOpen) {
      const details = el("div", { class: "evidence-rows" }, [evidenceTable(samples, c.cause)]);
      details.addEventListener("click", (e) => e.stopPropagation());
      card.append(details);
    }
    const toggle = () => onToggle(c.cause);
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    return card;
  }));
}

export function renderErrors(node, errors) {
  if (!errors?.length) {
    replaceChildren(node, [el("p", { class: "empty", text: "None found." })]);
    return;
  }
  const rows = errors.map((e) => el("tr", {}, [
    el("td", { text: when(e.ts) }),
    el("td", { class: "muted", text: e.source }),
    el("td", {}, [el("span", { class: `tag ${e.kind}`, text: e.kind })]),
    el("td", { class: e.verdict === "not_local" ? "muted" : "", text: humanize(e.verdict) }),
    el("td", { class: "muted", text: e.detail }),
  ]));
  replaceChildren(node, [el("div", { class: "scroll" }, [
    el("table", {}, [
      el("thead", {}, [el("tr", {}, ["when", "source", "kind", "verdict", "detail"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ])]);
}

export function renderSamples(node, samples) {
  const rows = (samples || []).slice(0, 60).map((s) => el("tr", {}, [
    el("td", { text: when(s.ts) }),
    el("td", { class: s.culprit ? "" : "muted", text: s.culprit ? humanize(s.culprit) : "ok" }),
    el("td", { text: ms(s.gw_ms) }), el("td", { text: ms(s.inet_ms) }),
    el("td", { text: ms(s.dns_router_ms) }), el("td", { text: ms(s.tls_ms) }),
  ]));
  replaceChildren(node, [el("div", { class: "scroll" }, [
    el("table", {}, [
      el("thead", {}, [el("tr", {}, ["when", "verdict", "gw", "inet", "dns", "tls"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ])]);
}

export function envRows(scan) {
  const s = scan || {}, w = s.wifi || {}, dr = s.driver || {}, c = s.congestion || {};
  return Object.entries({
    SSID: w.ssid,
    Signal: w.rssi_dbm != null ? `${w.rssi_dbm} dBm (${w.signal_pct}%)` : undefined,
    Band: w.band, Channel: w.channel, Radio: w.radio,
    "Rx / Tx": w.rx_mbps && w.tx_mbps ? `${w.rx_mbps} / ${w.tx_mbps} Mbps` : undefined,
    "Co-channel APs": c.state === "ok" ? `${c.cochannel} (${c.same_block} in 80MHz block)` : undefined,
    Adapter: dr.adapter, Driver: dr.driver && `${dr.driver} (${dr.driver_date})`,
    "Wireless mode": dr.wireless_mode, Roaming: dr.roaming,
  }).filter(([, v]) => v !== undefined && v !== null && v !== "");
}

export function renderEnv(node, scan) {
  const rows = envRows(scan);
  if (!scan?.wifi || !rows.length) {
    replaceChildren(node, [el("p", { class: "empty" }, [document.createTextNode("Run "), el("code", { text: "network-checker scan" }), document.createTextNode(".")])]);
    return;
  }
  replaceChildren(node, [el("table", {}, [el("tbody", {}, rows.map(([k, v]) => el("tr", {}, [
    el("td", { class: "muted", text: k }), el("td", { text: String(v) }),
  ])))])]);
}

/** One reusable chart renderer for both the latency and loss/jitter panels —
 * only the series definitions and floor differ between callers. */
export function renderChart(svg, tooltip, samples, seriesDefs, { floor = 50, bandPredicate } = {}) {
  const rows = (samples || []).slice(0, 180).reverse();
  const chart = buildChart(rows, seriesDefs.map((s) => s.key), { floor });
  svg.setAttribute("viewBox", `0 0 ${chart.width} ${chart.height}`);
  replaceChildren(svg, []);
  if (rows.length < 2) return chart;

  if (bandPredicate) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", bandsPath(chart, bandPredicate));
    path.setAttribute("fill", "var(--bad)");
    path.setAttribute("opacity", ".16");
    svg.append(path);
  }
  for (const { key, color, width, dash } of seriesDefs) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", polyline(chart.series[key]));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", String(width || 1.5));
    if (dash) line.setAttribute("stroke-dasharray", dash);
    svg.append(line);
  }

  svg.onpointermove = (e) => {
    const rect = svg.getBoundingClientRect();
    const localX = ((e.clientX - rect.left) / rect.width) * chart.width;
    const i = nearestIndex(chart, localX);
    const row = rows[i];
    if (!row) return;
    tooltip.style.left = `${((chart.xAt(i) / chart.width) * rect.width)}px`;
    tooltip.style.top = "0px";
    replaceChildren(tooltip, [el("dl", {}, seriesDefs.flatMap(({ key, label: l }) => [
      el("dt", { text: l }), el("dd", { text: row[key] == null ? "—" : `${Math.round(row[key])}` }),
    ])), el("div", { class: "muted", text: when(row.ts) })]);
    tooltip.classList.add("visible");
  };
  svg.onpointerleave = () => tooltip.classList.remove("visible");
  return chart;
}
