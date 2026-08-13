// Global keyboard model (docs/planning/09-design-system.md section 4.3),
// the subset Chrome owns directly: Ctrl/Cmd+K, the g-chord zone navigation
// (800ms window), and Shift+/. Escape is deliberately NOT handled here --
// Base UI's Dialog primitive already closes on Escape and restores focus to
// "the trigger or previously focused element" by default (see
// DialogPopup's `finalFocus` doc comment in @base-ui/react/dialog), and
// Chrome only ever has one overlay open at a time (a single activeOverlay
// state in chrome.tsx), so a second, hand-rolled Escape handler here would
// be redundant, not additive. "Escape... cancel in-progress inline edit"
// (the other half of that table row) has no target in this issue's scope --
// no inline-edit surface exists yet.

import * as React from "react";
import type { Zone } from "./zones";

const TEXT_INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * 09 section 4.3: "single-character shortcuts are suppressed whenever focus
 * is inside a text input." SELECT is included alongside INPUT/TEXTAREA even
 * though the rule says "text input" literally: a focused native <select>
 * also consumes single-key presses for its own type-ahead option jumping,
 * so leaving it out would let the chord/shortcuts-overlay keys silently
 * fight that native behavior instead of yielding to it.
 */
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (TEXT_INPUT_TAGS.has(target.tagName)) return true;
  return target.isContentEditable;
}

function isPaletteShortcut(event: KeyboardEvent): boolean {
  // 09 section 4.2, Trigger row: "Ctrl+K / Cmd+K anywhere, including inside
  // inputs" -- deliberately NOT gated by isTextInputTarget, unlike the two
  // checks below.
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k";
}

function isShortcutsOverlayKey(event: KeyboardEvent): boolean {
  // Shift flips "/" to "?" on a US layout, which is what event.key actually
  // reports; some non-US layouts still report "/" with shiftKey set, so
  // both are accepted.
  return event.shiftKey && (event.key === "?" || event.key === "/");
}

const CHORD_KEYS: Readonly<Record<string, Zone>> = {
  h: "home",
  l: "life",
  a: "acc",
  t: "tools",
  p: "prompts",
  i: "ideas",
};

const CHORD_WINDOW_MS = 800;

export interface GlobalKeyboardModelOptions {
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  onNavigate: (zone: Zone) => void;
  /** Escape hatch for tests; Chrome itself always leaves this at the default. */
  enabled?: boolean;
}

/**
 * Attaches one capture-phase `keydown` listener on `document` for the
 * lifetime of the calling component. Capture phase so the global shortcuts
 * cannot be blocked by an unrelated `stopPropagation()` somewhere in the
 * tree; it never calls `stopPropagation()` itself, and for every key it
 * doesn't recognize (including every key while focus is in a text input,
 * per isTextInputTarget above) it does nothing and lets the event continue
 * to bubble normally -- so typing inside the command palette's own search
 * input, for example, is completely unaffected by this hook.
 */
export function useGlobalKeyboardModel({
  onOpenPalette,
  onOpenShortcuts,
  onNavigate,
  enabled = true,
}: GlobalKeyboardModelOptions): void {
  const chordArmedUntilRef = React.useRef(0);
  // Keep the latest callbacks in a ref so the effect below can have an
  // empty dependency array (attach the listener once) without closing over
  // stale callback identities across re-renders.
  const callbacksRef = React.useRef({ onOpenPalette, onOpenShortcuts, onNavigate });
  callbacksRef.current = { onOpenPalette, onOpenShortcuts, onNavigate };

  React.useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    function handleKeyDown(event: KeyboardEvent) {
      if (isPaletteShortcut(event)) {
        event.preventDefault();
        chordArmedUntilRef.current = 0;
        callbacksRef.current.onOpenPalette();
        return;
      }

      if (isTextInputTarget(event.target)) {
        chordArmedUntilRef.current = 0;
        return;
      }

      if (chordArmedUntilRef.current > Date.now()) {
        const zone = CHORD_KEYS[event.key.toLowerCase()];
        chordArmedUntilRef.current = 0;
        if (zone && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          callbacksRef.current.onNavigate(zone);
        }
        return;
      }

      if (isShortcutsOverlayKey(event)) {
        event.preventDefault();
        callbacksRef.current.onOpenShortcuts();
        return;
      }

      if (event.key.toLowerCase() === "g" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        chordArmedUntilRef.current = Date.now() + CHORD_WINDOW_MS;
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled]);
}
