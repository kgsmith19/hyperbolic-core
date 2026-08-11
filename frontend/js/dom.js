// Minimal hyperscript helper. No JSX, no build step: this is what turns
// `el("tr", {}, [el("td", {text: "x"})])` into an actual DOM node, safely —
// every string goes through textContent, never innerHTML.
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replaceChildren(node, children) {
  clear(node);
  for (const child of children) if (child) node.append(child);
}
