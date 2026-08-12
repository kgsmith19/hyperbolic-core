"use client";

import { Sun, Moon, Monitor } from "lucide-react";

import { cn } from "../lib/cn";
import { useThemeChoice, type ThemeChoice } from "./theme";

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Single-button theme cycle (system -> light -> dark -> system), the
 * topbar's compact control (09 section 4.1) for the theme persistence
 * contract in 09 section 3.1. Mirrors ACC's existing single-button toggle
 * idiom (main.tsx `aria-label="toggle theme"` [VERIFIED, cited in 09
 * section 4.3]), extended from 2 states to the 3 this platform needs.
 *
 * The full three-way *settings-page* presentation 05-a section 8 describes
 * ("Theme (light/dark/system), persisted locally") is out of scope here --
 * no Settings page exists yet, and this issue's scope list names only the
 * chrome/topbar switch. `useThemeChoice` is exported separately from
 * ./theme specifically so that page can build its own richer control
 * later on the exact same persistence primitive, instead of duplicating
 * the storage key or the cascade-application logic.
 */
function ThemeSwitch({ className }: { className?: string }) {
  const [choice, cycle] = useThemeChoice();
  const Icon = THEME_ICON[choice];

  return (
    <button
      type="button"
      data-slot="theme-switch"
      data-theme-choice={choice}
      onClick={cycle}
      aria-label={`Switch theme (currently ${THEME_LABEL[choice]})`}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-accent-muted hover:text-text focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

export { ThemeSwitch };
