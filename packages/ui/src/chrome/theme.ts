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

/**
 * Owns the persisted theme choice for the lifetime of one mounted Chrome.
 *
 * Scope note, honestly stated: this hook guarantees zero *added* flash from
 * Chrome's own mount and flip behavior (proven in this issue's tests). It
 * cannot, by construction, prevent the very-first cold-load flash a real
 * browser tab could show before any JavaScript runs -- that requires a
 * blocking inline script in the HTML `<head>`, executed before first paint,
 * which is apps/shell's index.html (m2-02) to own once it exists. What this
 * hook does today: read the stored choice synchronously on mount (the lazy
 * useState initializer, safe under SSR) and re-apply it in a layout effect
 * -- before paint -- so mounting Chrome itself never shows one wrong frame.
 */
export function useThemeChoice(): [ThemeChoice, () => void] {
  const [choice, setChoice] = React.useState<ThemeChoice>(readStoredChoice);

  // Mount-only (empty deps, deliberately not reactive to `choice`): this
  // applies whatever the lazy initializer above already read, in a layout
  // effect so it lands before the browser's first paint of this subtree.
  // `cycle` below applies every subsequent change itself, synchronously and
  // immediately in the click handler -- re-running this effect on every
  // `choice` change would just repeat that same DOM write a frame later,
  // adding a redundant paint rather than any correctness.
  useIsomorphicLayoutEffect(() => {
    applyThemeChoice(choice);
  }, []);

  const cycle = React.useCallback(() => {
    setChoice((current) => {
      const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length];
      applyThemeChoice(next);
      return next;
    });
  }, []);

  return [choice, cycle];
}
