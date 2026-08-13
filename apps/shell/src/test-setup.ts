import "@testing-library/jest-dom/vitest";

// jsdom has no real viewport, so it doesn't implement window.matchMedia at
// all. packages/ui's NavRail (rendered by Chrome, which
// components/protected-layout.test.tsx renders for a signed-in session)
// reads `window.matchMedia("(min-width: 1024px)").matches` once at mount to
// pick its initial collapsed/expanded state -- polyfill just enough of the
// MediaQueryList surface for that read to succeed. `matches: false` mirrors
// jsdom's own effective 0-width default, so tests get the same
// "collapsed by default under 1024px" behavior 09 section 4.1 documents.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
