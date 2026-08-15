// The Shell's handle on the platform notification surface (m2-05;
// docs/planning/05-a-hyperbolic-core.md section 7, contract C-4).
//
// There is exactly ONE surface per document and @hyperbolic/ui owns it --
// this module does not construct a second one, it takes the singleton and
// re-exports it under a Shell-local name, the same way src/lib/session.ts
// is the one place the Shell's platform client lives. Everything that
// renders it (the toast stack, the topbar bell) lives inside Chrome, so the
// only wiring the Shell owns is handing this instance to Chrome
// (src/components/protected-layout.tsx) and, in an e2e build only, exposing
// it on `window`.
//
// The Shell publishes nothing of its own yet, deliberately: the producers
// this surface exists for are the Brain's run events (m4-14/m4-16), named
// out of scope by this issue's own text. What ships here is the surface and
// its presentation, ready for those producers.
import { getNotificationSurface, type NotificationSurface } from "@hyperbolic/ui";

export const notificationSurface: NotificationSurface = getNotificationSurface();

declare global {
  interface Window {
    __hyperbolicNotifications?: NotificationSurface;
  }
}

// e2e-only hook, identical in mechanism and gating to src/lib/session.ts's
// __hyperbolicPlatformClient: VITE_E2E_HOOKS is set ONLY by
// playwright.config.ts's webServer command, never by a plain `npm run
// build`, so no real deploy assigns anything on `window`.
//
// e2e/notifications.spec.ts uses it to play the part of the notification
// PRODUCER that does not exist yet (see above) -- it publishes through the
// real contract, into the real surface, and everything downstream of
// publish (transport, timers, stack limit, live region) is the real
// shipped code under test.
if (import.meta.env?.VITE_E2E_HOOKS === "1" && typeof window !== "undefined") {
  window.__hyperbolicNotifications = notificationSurface;
}
