// "Deployable unit" + "health route", made concrete for the Settings page
// (docs/planning/05-a-hyperbolic-core.md section 8: "Unit health: one row
// per deployable unit calling its health route").
//
// There is no live registry API yet (m3-04 builds that -- see this issue's
// own out-of-scope list). Interim approach, a judgment call flagged here per
// this issue's instructions rather than silently guessed: a small static
// list of the units this monorepo already documents as independently
// deployable, each carrying whatever health check ITS OWN manifest/doc
// already commits to. Two shapes show up in the real manifests, and both are
// represented honestly rather than forced into one:
//
//   - "http": a real, browser-fetchable URL. Only Shell, ACC, and LifeOS
//     have one today (Shell trivially -- see "self" below; ACC per 05-b
//     section 5; LifeOS per apps/lifeos/backend/src/api/main.py's
//     `GET /healthz`, reachable in production at /life/api/healthz per the
//     05-a section 4 route map's `/life/api/*` prefix).
//   - "command": every apps/toolbelt/**/tool.json manifest's own
//     `lifecycle.health` field (apps/toolbelt/tool.schema.json: "Command or
//     URL path that exits 0 / returns 200 when the tool is healthy") is
//     documented today as a CLI command (e.g. `node --test "tests/*.test.mjs"`),
//     not a URL -- toolbelt's root spine, Prompt Organizer, and Network
//     Checker all currently document their health check this way. A browser
//     page cannot execute a local shell command, so these rows render the
//     documented command as reference text plus a "Manual check" status
//     rather than pretending to fetch something that doesn't exist. Once any
//     of these tools gains an HTTP health route this list is a one-line
//     change to "http".
//
// This list intentionally excludes tools that are not themselves separately
// deployable (e.g. Idea Intake, which per 05-h will be Shell-served content,
// not its own unit).
import { ACC_STATUS_URL } from "./acc";

export type UnitHealthCheck =
  | { kind: "self"; note: string }
  | { kind: "http"; url: string; note: string }
  | { kind: "command"; command: string; note: string };

export interface DeployableUnit {
  id: string;
  name: string;
  health: UnitHealthCheck;
}

// Production topology: LifeOS backend at /life/api/* (05-a section 4).
// VITE_LIFEOS_API overrides for local dev against a directly-running
// backend (e.g. http://127.0.0.1:8000) that isn't behind that path prefix.
// See lib/acc.ts's comment on ACC_BASE_URL: import.meta.env can be undefined
// entirely (e2e/chrome.spec.ts imports this module under Playwright's
// plain-Node loader, not Vite), hence the optional chain on env itself.
const LIFEOS_HEALTH_URL = import.meta.env?.VITE_LIFEOS_API
  ? `${import.meta.env.VITE_LIFEOS_API.replace(/\/+$/, "")}/healthz`
  : "/life/api/healthz";

export const DEPLOYABLE_UNITS: readonly DeployableUnit[] = [
  {
    id: "shell",
    name: "Shell",
    health: {
      kind: "self",
      note: "This Shell instance is serving the page you are viewing right now.",
    },
  },
  {
    id: "acc",
    name: "Agentic Command Center",
    health: {
      kind: "http",
      url: ACC_STATUS_URL,
      note: "GET /api/process/status, operator-machine loopback (05-b section 5).",
    },
  },
  {
    id: "lifeos",
    name: "LifeOS",
    health: {
      kind: "http",
      url: LIFEOS_HEALTH_URL,
      note: "GET /healthz (apps/lifeos/backend/src/api/main.py); deploy smoke check per apps/lifeos/project.yaml.",
    },
  },
  {
    id: "toolbelt",
    name: "Toolbelt root spine",
    health: {
      kind: "command",
      command: 'node --test "tests/*.test.mjs"',
      note: "apps/toolbelt/tool.json lifecycle.health",
    },
  },
  {
    id: "prompt-organizer",
    name: "Prompt Organizer",
    health: {
      kind: "command",
      command: 'node --test "tests/*.test.mjs"',
      note: "apps/toolbelt/apps/prompt-organizer/tool.json lifecycle.health",
    },
  },
  {
    id: "network-checker",
    name: "Network Checker",
    health: {
      kind: "command",
      command: "bash tools/check.sh",
      note: "apps/toolbelt/apps/network-checker/tool.json lifecycle.health",
    },
  },
];
