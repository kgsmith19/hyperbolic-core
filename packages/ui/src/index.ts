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
export type { PlatformSession, ToolPaletteEntry } from "./chrome/types";
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
export { applyThemeChoice, useThemeChoice } from "./chrome/theme";
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

// m4-15, the Brain run/chat surface primitives (docs/planning/09-design-
// system.md section 7). Page wiring and SSE consumption are m4-16's job;
// this package only ships the presentational pieces and their pure
// streaming/virtualization/approval-gate logic.
export { RunId } from "./chat/run-id";
export { OperatorMessage, AgentMessage, ToolCallBlock, SystemRow } from "./chat/transcript-blocks";
export type { OperatorMessageState, AgentMessageState, ToolCallStatus } from "./chat/transcript-blocks";
export { ApprovalCard } from "./chat/approval-card";
export {
  initialApprovalState,
  toggleEvidence,
  markEvidenceSeen,
  canApprove,
  resolveApproved,
  resolveRejected,
  resolveExpired,
  mapApprovalKey,
  countLines,
  AUTO_EXPAND_LINE_THRESHOLD,
} from "./chat/approval-machine";
export type {
  ApprovalCardState,
  ApprovalResolution,
  ApprovalKeyAction,
  ApprovalKeyEvent,
  Evidence,
  EvidenceKind,
} from "./chat/approval-machine";
export { Composer } from "./chat/composer";
export type { ComposerTarget } from "./chat/composer";
export { StatusStrip } from "./chat/status-strip";
export type { ConnectionState, RunState } from "./chat/status-strip";
export { CostTicker } from "./chat/cost-ticker";
export { Transcript } from "./chat/transcript";
export type { TranscriptItem } from "./chat/transcript";
export {
  VIRTUALIZE_THRESHOLD,
  shouldVirtualize,
  buildOffsets,
  computeVirtualRange,
} from "./chat/virtualize";
export type { VirtualRange, VirtualRangeInput } from "./chat/virtualize";
export {
  createTokenBuffer,
  appendToken,
  flushTokenBuffer,
  useCoalescedStream,
} from "./chat/stream-buffer";
export type { TokenBufferState, FlushResult, CoalescedStreamHandle } from "./chat/stream-buffer";
export {
  initialAutoscrollState,
  onScroll as onTranscriptScroll,
  onNewContent as onTranscriptNewContent,
  jumpToLatest as jumpToLatestTranscript,
  BOTTOM_THRESHOLD_PX,
} from "./chat/autoscroll";
export type { AutoscrollState, ScrollMetrics } from "./chat/autoscroll";

export { cn } from "./lib/cn";
