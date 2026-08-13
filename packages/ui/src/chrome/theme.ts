// Theme persistence (docs/planning/09-design-system.md section 3.1).
//
// tokens.css's three-tier cascade (bare :root light -> prefers-color-scheme
// media query -> explicit [data-theme] override) is the binding mechanism;
// this module is only responsible for the "explicit choice" tier: mapping
// a user's light/dark/system pick onto the `data-theme` attribute and
// localStorage, synchronously, with no React scheduling in the critical
// path -- that synchronicity is what the 50ms/no-flash acceptance
// criterion is actually about (see applyThemeChoice below and
// theme-switch.tsx's onClick, which calls it directly rather than routing
// the DOM write through an effect).

import * as React from "react";

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "hyperbolic-ui-theme";
const CYCLE: readonly ThemeChoice[] = ["system", "light", "dark"];

function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredChoice(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemeChoice(stored) ? stored : "system";
  } catch {
    // Storage can throw under locked-down storage policies (private
    // browsing quotas, disabled storage); fail to the spec's own default
    // ("no stored choice: follow the OS") rather than crash the chrome
    // every zone renders.
    return "system";
  }
}

/**
 * Applies `choice` to the document root: one synchronous attribute
 * mutation, no scheduling. "system" removes `data-theme` entirely so tier 2
 * of tokens.css's cascade (the `prefers-color-scheme` media query) governs,
 * matching "default with no stored choice: follow the OS" (section 3.1).
 * Exported (not just called internally) so a future bootstrap script in
 * apps/shell's index.html (needed for true cold-load flash prevention,
 * which requires a blocking script before this package's JS even parses --
 * see the module-level note below) can reuse the exact same key and
 * mapping instead of re-deriving them.
 */
export function applyThemeChoice(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Best-effort persistence only; the in-memory/applied choice still
      // takes visual effect for the rest of this session.
    }
  }
}

// useLayoutEffect warns when it runs during server rendering. This package
// has no SSR entry point of its own, but its test suite renders via
// react-dom/server (matching test/focus-visible.test.mjs's established
// pattern), so guard the standard isomorphic way rather than emitting that
// warning on every test run.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

// ---------------------------------------------------------------------
// Finding #73 (PR #8 security review): shared cross-instance store.
//
// Previously `useThemeChoice` was plain per-component `React.useState` with
// no cross-instance channel at all -- two independently mounted consumers
// (e.g. the topbar's ThemeSwitch and Settings' own ThemeChoiceControl, both
// documented at the time as a known, out-of-scope gap from m2-01) could
// show stale/disagreeing DISPLAYED selections relative to each other until
// one of them remounted, even though the actually-applied theme (the
// document's `data-theme` attribute + localStorage, via applyThemeChoice)
// stayed correct and instant everywhere the instant either one changed it.
//
// The fix is a module-level store (module scope, one instance per loaded
// copy of this file/document -- exactly the same scope every other
// consumer of this module already shares) plus React's own
// `useSyncExternalStore`, the primitive built for precisely this shape of
// problem: an external mutable value, read by multiple components, that
// must re-render every subscriber synchronously when any one of them
// writes to it. This closes the SAME-TAB, same-document gap the finding
// describes. Deliberately NOT also adding a `storage` event listener for
// cross-TAB sync: the finding names that as an alternative ("OR"), not an
// additional requirement, and the drift it describes ("two independently
// mounted consumers") is a same-document scenario (both controls rendered
// by the same running Chrome instance), not a cross-tab one.
//
// Exported (not just used internally) so this file's own tests can import
// the SOURCE module directly and exercise the pub/sub mechanics without
// needing a DOM -- see test/chrome-theme-store.test.mjs's header comment.
// These three are deliberately NOT re-exported from packages/ui/src/index.ts:
// only `useThemeChoice` (which uses them) and `applyThemeChoice` are public.

let sharedChoice: ThemeChoice | null = null;
const listeners = new Set<() => void>();

/** The current shared choice, lazily read from storage on first access. */
export function getThemeChoiceSnapshot(): ThemeChoice {
  if (sharedChoice === null) sharedChoice = readStoredChoice();
  return sharedChoice;
}

/**
 * `useSyncExternalStore`'s server-snapshot argument: a fixed, deterministic
 * value for SSR (matching readStoredChoice()'s own no-`window` default) so
 * this package's SSR-based test suite (react-dom/server, no `window`) never
 * hits useSyncExternalStore's "missing getServerSnapshot" warning/throw.
 */
export function getThemeChoiceServerSnapshot(): ThemeChoice {
  return "system";
}

/** Subscribes `listener` to every future shared-choice change; returns an unsubscribe function. */
export function subscribeThemeChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Updates the ONE shared choice, applies it to the DOM (once, regardless of
 * how many `useThemeChoice()` instances are mounted), and synchronously
 * notifies every subscriber -- this is what makes two independently
 * rendered consumers observe the same value without either remounting.
 */
export function setThemeChoiceSnapshot(next: ThemeChoice): void {
  sharedChoice = next;
  applyThemeChoice(next);
  for (const listener of listeners) listener();
}

/**
 * Owns the persisted theme choice for the lifetime of one mounted Chrome.
 *
 * Scope note, honestly stated: this hook guarantees zero *added* flash from
 * Chrome's own mount and flip behavior (proven in this issue's tests). It
 * cannot, by construction, prevent the very-first cold-load flash a real
 * browser tab could show before any JavaScript runs -- that requires a
 * blocking inline script in the HTML `<head>`, executed before first paint,
 * which is apps/shell's index.html (m2-02) to own once it exists. What this
 * hook does today: read the stored choice synchronously on mount (via
 * `useSyncExternalStore`, safe under SSR through `getThemeChoiceServerSnapshot`)
 * and re-apply it in a layout effect -- before paint -- so mounting Chrome
 * itself never shows one wrong frame.
 */
export function useThemeChoice(): [ThemeChoice, () => void] {
  const choice = React.useSyncExternalStore(
    subscribeThemeChoice,
    getThemeChoiceSnapshot,
    getThemeChoiceServerSnapshot
  );

  // Mount-only (empty deps, deliberately not reactive to `choice`): applies
  // whatever the shared store currently holds, in a layout effect so it
  // lands before the browser's first paint of THIS subtree -- harmless and
  // idempotent to repeat across multiple simultaneously-mounted consumers
  // (each already did this same "apply on my own mount" step independently
  // before this fix too). `cycle` below applies every subsequent change
  // itself, synchronously and immediately in the click handler.
  useIsomorphicLayoutEffect(() => {
    applyThemeChoice(getThemeChoiceSnapshot());
  }, []);

  const cycle = React.useCallback(() => {
    const next = CYCLE[(CYCLE.indexOf(getThemeChoiceSnapshot()) + 1) % CYCLE.length];
    setThemeChoiceSnapshot(next);
  }, []);

  return [choice, cycle];
}
