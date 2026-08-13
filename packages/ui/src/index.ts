// Single public entry for @hyperbolic/ui.
//
// Deep imports into "@hyperbolic/ui/primitives/*", "@hyperbolic/ui/feedback/*",
// or any other package-internal path are a contract violation. Consume the
// package only through this file:
//   import { Button, Dialog, EmptyState } from "@hyperbolic/ui";
// Styles are a separate, explicit import (adoption rule 1,
// docs/planning/09-design-system.md section 8):
//   import "@hyperbolic/ui/styles/tokens.css";

export { Button, buttonVariants } from "./primitives/button";
export { Badge, badgeVariants } from "./primitives/badge";
export { Card, CardHeader, CardTitle, CardContent } from "./primitives/card";
export { Input } from "./primitives/input";
export { Label } from "./primitives/label";
export { RadioGroup, RadioGroupItem } from "./primitives/radio-group";
export { Textarea } from "./primitives/textarea";
export { Select, SelectItem, selectVariants } from "./primitives/select";
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./primitives/dialog";
export { Tabs, TabsList, TabsTab, TabsIndicator, TabsPanel } from "./primitives/tabs";

export { Chrome } from "./chrome/chrome";
export type { ChromeProps } from "./chrome/chrome";
export type { Zone } from "./chrome/zones";
export type { PlatformSession } from "./chrome/session";
export type { ToolPaletteEntry } from "./chrome/tool-entry";
export { ThemeSwitch } from "./chrome/theme-switch";
// Added by apps/shell (m2-02): theme-switch.tsx's own doc comment already
// names this exact purpose -- "useThemeChoice is exported separately from
// ./theme specifically so that [the Settings] page can build its own richer
// control later on the exact same persistence primitive, instead of
// duplicating the storage key or the cascade-application logic." It was
// exported from chrome/theme.ts already, just never re-exported through
// this package's public entry; Settings (05-a section 8, "Theme
// (light/dark/system), persisted locally") is that consumer. Purely
// additive -- no existing export's shape changes.
export { useThemeChoice } from "./chrome/theme";
export type { ThemeChoice } from "./chrome/theme";
export { paletteMatch } from "./chrome/palette-match";

// m2-05, the notification surface (05-a section 7 / contract C-4, presented
// per 09 section 4.5). Chrome renders the toast stack and the bell inbox
// itself, so a zone normally needs exactly ONE of these: the
// `getNotificationSurface()` singleton to publish through. The types are
// the 05-a section 7 contract verbatim.
export { getNotificationSurface, createNotificationSurface, NOTIFICATION_CHANNEL } from "./notifications/surface";
export type {
  NotificationSurfaceOptions,
  NotificationSurfaceHandle,
} from "./notifications/surface";
export type {
  NotificationLevel,
  PlatformNotification,
  NotificationSurface,
  PublishableNotification,
  Unsubscribe,
} from "./notifications/types";

export { EmptyState } from "./feedback/empty-state";
export { Skeleton, useDelayedVisible } from "./feedback/skeleton";
export { Spinner } from "./feedback/spinner";
export { InlineError } from "./feedback/inline-error";
export { ErrorState } from "./feedback/error-state";

export { cn } from "./lib/cn";
