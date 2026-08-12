// light / dark / system, persisted, applied before first paint by the inline
// bootstrap in index.html so there is never a flash of the wrong theme.
const KEY = "netcheck:theme";
const ORDER = ["system", "light", "dark"];

export function currentTheme() {
  return localStorage.getItem(KEY) || "system";
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function setTheme(theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

export function cycleTheme() {
  const next = ORDER[(ORDER.indexOf(currentTheme()) + 1) % ORDER.length];
  setTheme(next);
  return next;
}
