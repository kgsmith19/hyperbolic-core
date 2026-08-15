import type { PlatformSession } from "@hyperbolic/platform-client";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@hyperbolic/ui";
import { APP_VERSION, BUILD_SHA, BUILD_TIME } from "../lib/build-info";
import { DEPLOYABLE_UNITS } from "../lib/units";
import { UnitHealthRow } from "../components/unit-health-row";
import { ThemeChoiceControl } from "../components/theme-choice-control";

// docs/planning/05-a-hyperbolic-core.md section 8's exact table, one card
// per row: theme, session card, unit health, version/build info, break-glass
// link. "user management" / "secret values" / "feature flags" /
// "per-app settings" / "notification history" are explicitly out of scope
// there and are not rendered here.
const BREAK_GLASS_URL =
  "https://github.com/kgsmith19/hyperbolic-core/blob/main/apps/lifeos/backend/docs/runbook.md#local-development";

interface SettingsPageProps {
  session: PlatformSession;
  onSignOut: () => void;
}

function SettingsPage({ session, onSignOut }: SettingsPageProps) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text">Settings</h2>
        <p className="mt-1 text-sm text-text-secondary">docs/planning/05-a-hyperbolic-core.md section 8</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-sm text-text-secondary">Theme, persisted locally</p>
          <ThemeChoiceControl />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3" data-testid="session-card">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-text-secondary">User</dt>
            <dd className="truncate font-mono text-text">{session.userId}</dd>
            <dt className="text-text-secondary">Session expires</dt>
            <dd className="text-text">{new Date(session.expiresAt * 1000).toLocaleString()}</dd>
          </dl>
          <Button type="button" variant="outline" size="sm" onClick={onSignOut} className="self-start">
            Sign out
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Unit health</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          {DEPLOYABLE_UNITS.map((unit) => (
            <UnitHealthRow key={unit.id} unit={unit} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Version</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-text-secondary" data-testid="version-info">
          Shell v{APP_VERSION} &middot; build {BUILD_SHA} &middot; built {new Date(BUILD_TIME).toLocaleString()}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Break-glass</CardTitle>
        </CardHeader>
        <CardContent>
          <a
            href={BREAK_GLASS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-accent hover:underline"
          >
            LifeOS break-glass runbook (LIFEOS_AUTH_MODE=disabled, localhost only) ↗
          </a>
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsPage;
