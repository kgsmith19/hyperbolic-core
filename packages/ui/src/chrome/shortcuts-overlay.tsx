"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

interface ShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: "Ctrl/Cmd K", action: "Open command palette" },
  { keys: "Esc", action: "Close the open overlay" },
  { keys: "g then h/l/a/t/p/i", action: "Go to Home/LifeOS/ACC/Tools/Prompts/Ideas" },
  { keys: "Shift /", action: "Show this reference" },
];

/**
 * 09 section 4.3, Shift+/ row: "shortcut reference overlay." Scoped to
 * exactly the shortcuts Chrome itself implements in this issue. It does
 * NOT list that same table's ACC run-surface bindings (j/k, o, y/n, d) --
 * those belong to the chat surface (m4-15), which is explicitly out of
 * scope here and does not exist yet, so listing them would document
 * behavior this package doesn't actually ship.
 */
function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="shortcuts-overlay-backdrop"
          className="fixed inset-0 z-50 bg-overlay transition-opacity duration-base ease-standard data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <DialogPrimitive.Popup
            data-slot="shortcuts-overlay"
            aria-label="Keyboard shortcuts"
            className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-5 text-text shadow-2 outline-none transition-[opacity,transform] duration-base ease-standard data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0"
          >
            <h2 className="text-sm font-semibold text-text">Keyboard shortcuts</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {SHORTCUTS.map((shortcut) => (
                <li
                  key={shortcut.keys}
                  className="flex items-center justify-between gap-4 text-sm"
                >
                  <span className="text-text-secondary">{shortcut.action}</span>
                  <kbd className="rounded border border-border-strong bg-bg-subtle px-1.5 py-0.5 font-mono text-xs text-text">
                    {shortcut.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { ShortcutsOverlay };
