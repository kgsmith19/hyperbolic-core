import { replaceChildren, el } from "./dom.js";

/** A Cmd/Ctrl+K command palette over a <dialog>. Native <dialog> gives us
 * focus trapping, Escape-to-close, and a backdrop for free — no library
 * needed to build the pattern every modern dashboard now ships. */
export function initPalette(dialog, input, list, commands) {
  let filtered = commands;
  let selected = 0;

  function renderList() {
    replaceChildren(list, filtered.map((cmd, i) => el("li", {
      role: "option", "aria-selected": String(i === selected), id: `cmd-${i}`,
      onclick: () => run(i),
    }, [el("span", { text: cmd.title }), cmd.hint ? el("span", { class: "k", text: cmd.hint }) : null])));
    input.setAttribute("aria-activedescendant", filtered.length ? `cmd-${selected}` : "");
  }

  function run(i) {
    const cmd = filtered[i];
    close();
    if (cmd) cmd.run();
  }

  function open() {
    filtered = commands;
    selected = 0;
    input.value = "";
    renderList();
    dialog.showModal();
    input.focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    filtered = q ? commands.filter((c) => c.title.toLowerCase().includes(q)) : commands;
    selected = 0;
    renderList();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); selected = Math.min(selected + 1, filtered.length - 1); renderList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); selected = Math.max(selected - 1, 0); renderList(); }
    else if (e.key === "Enter") { e.preventDefault(); run(selected); }
  });

  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });

  return { open, close };
}
