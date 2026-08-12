import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

// DEVIATION FROM SPEC, flagged deliberately (see the m1-04 report): every
// other new primitive here wraps a @base-ui/react headless part. Select
// wraps the native <select> element instead. @base-ui/react's Select is
// anchor-positioned and pulls in its floating-ui positioning engine, which
// measured at 25-40 KB gzipped on its own (verified by bisecting the probe
// bundle export-by-export and inspecting @base-ui/react/select's module
// graph -- it is a single, non-splittable chunk, not a tree-shaking gap on
// this file's side). That alone exceeds the entire 60 KB package budget
// once the other nine required primitives are included, and there is no
// reduced-feature way to use @base-ui/react's Select without a Positioner.
// A native <select> gets full platform accessibility (screen readers,
// keyboard nav, the OS's own picker UI on mobile) at zero extra JS weight,
// at the cost of not being able to fully restyle the open option list.
const selectVariants = cva(
  // text-md (16px) below md: iOS Safari auto-zooms focused controls under
  // 16px; md:text-sm tightens once that no longer applies.
  "flex h-8 w-full appearance-none items-center justify-between gap-2 rounded-lg border border-border-strong bg-transparent px-2.5 py-1 pr-8 text-md outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 md:text-sm",
  {
    variants: {
      size: {
        default: "h-8",
        sm: "h-7 text-xs",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
);

interface SelectProps
  extends Omit<React.ComponentProps<"select">, "size">,
    VariantProps<typeof selectVariants> {
  wrapperClassName?: string;
}

function Select({
  className,
  wrapperClassName,
  size,
  children,
  ...props
}: SelectProps) {
  return (
    <div
      data-slot="select"
      data-size={size}
      className={cn("relative inline-block w-full", wrapperClassName)}
    >
      <select
        data-slot="select-input"
        className={cn(selectVariants({ size, className }))}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-text-secondary" />
    </div>
  );
}

function SelectItem({ className, ...props }: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="select-item"
      className={cn("text-text", className)}
      {...props}
    />
  );
}

export { Select, SelectItem, selectVariants };
