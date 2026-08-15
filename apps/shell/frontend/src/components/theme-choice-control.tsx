// Settings' own theme control (docs/planning/05-a-hyperbolic-core.md
// section 8: "Theme (light/dark/system), persisted locally").
//
// Chrome's topbar already renders a compact ThemeSwitch cycle-button on
// every single page (09 section 4.1) -- including this one, since Chrome
// wraps every route's content. Settings does NOT render a second
// `<ThemeSwitch />` instance here: theme.ts's `useThemeChoice` hook is
// plain per-component React state with no cross-instance channel (no
// BroadcastChannel/storage-event listener), so two independently mounted
// consumers CAN show stale icons relative to each other until one of them
// remounts, even though the actual applied theme (the shared
// document.documentElement `data-theme` attribute + localStorage,
// theme.ts's applyThemeChoice) stays correct and instant everywhere the
// instant either one is used. Rather than ship a second control that can
// visibly disagree with the topbar's, this builds an explicit three-way
// picker on the SAME persistence primitive (`useThemeChoice`, re-exported
// from packages/ui by this issue specifically for this -- see this issue's
// report and packages/ui/src/index.ts's comment on that export), which
// theme-switch.tsx's own doc comment names as exactly the intended reuse
// path. This narrow drift (topbar icon can lag one interaction behind a
// change made here, or vice versa, until either one is clicked or the route
// changes) is a pre-existing limitation of useThemeChoice's design (m2-01,
// packages/ui, out of this issue's scope to change), not something
// introduced here -- flagged explicitly in this issue's report.
import { RadioGroup, RadioGroupItem, useThemeChoice, type ThemeChoice } from "@hyperbolic/ui";

// Same order as theme.ts's own internal CYCLE constant (system -> light ->
// dark -> system). useThemeChoice exposes only `cycle` (advance one step),
// not a direct setter, matching the topbar's single-button idiom -- picking
// an arbitrary option here means stepping `cycle()` the right number of
// times, computed from this known order.
const ORDER: readonly ThemeChoice[] = ["system", "light", "dark"];
const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function ThemeChoiceControl() {
  const [choice, cycle] = useThemeChoice();

  function selectChoice(target: ThemeChoice) {
    const from = ORDER.indexOf(choice);
    const to = ORDER.indexOf(target);
    const steps = (to - from + ORDER.length) % ORDER.length;
    // `cycle` closes over setChoice's functional updater, so calling it N
    // times synchronously in one handler correctly composes N steps (each
    // call's updater sees the previous call's already-queued result) --
    // the same guarantee any functional setState update sequence gets.
    for (let i = 0; i < steps; i += 1) {
      cycle();
    }
  }

  return (
    <RadioGroup
      data-testid="theme-choice-control"
      aria-label="Theme"
      value={choice}
      onValueChange={(next) => selectChoice(next as ThemeChoice)}
      className="flex flex-row gap-4"
    >
      {OPTIONS.map((option) => (
        <label key={option.value} className="flex items-center gap-2 text-sm text-text">
          <RadioGroupItem value={option.value} />
          {option.label}
        </label>
      ))}
    </RadioGroup>
  );
}

export { ThemeChoiceControl };
