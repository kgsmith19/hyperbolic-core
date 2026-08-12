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

export { EmptyState } from "./feedback/empty-state";
export { Skeleton, useDelayedVisible } from "./feedback/skeleton";
export { Spinner } from "./feedback/spinner";
export { InlineError } from "./feedback/inline-error";
export { ErrorState } from "./feedback/error-state";

export { cn } from "./lib/cn";
