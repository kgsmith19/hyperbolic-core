import { toCsv } from "./format.js";

function download(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

export function exportJson(data) {
  download("netcheck-report.json", "application/json", JSON.stringify(data, null, 2));
}

export function exportCsv(samples) {
  download("netcheck-samples.csv", "text/csv", toCsv(samples || []));
}
