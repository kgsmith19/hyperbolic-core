# Agentic Command Center

Agentic Command Center (ACC) is an adapter-driven local coding-agent service,
guard rail, and React control panel. It protects selected files and secrets,
provides a loopback API, runs bounded headless tasks, and carries directives
across fresh contexts. Claude Code is the current harness integration; the
kernel selects harnesses through `kernel/adapters/`.

## Requirements

- Node.js 22 or newer
- npm
- Windows and PowerShell 5.1 or newer for the launch shim and cap watcher

## Run

```bash
npm install
npm run gui                             # http://127.0.0.1:43117
node kernel/run.mjs <contract.json>     # one bounded headless task
node kernel/ledger.mjs query            # inspect kernel runs
node runner/runner.mjs directive:<id>   # run a directive headlessly
cd ui && npm ci && npm run build        # build the React control panel
node gui/server.mjs --ui-dist ui/dist   # serve the built UI same-origin
```

## Verify

```bash
npm test
npm run covgate
npm run test:windows
cd ui && npm run build
cd ui && ACC_DIR=.. npm run e2e
```

`npm run test:windows` and the PowerShell suites require Windows. Real-token
proof commands are manual and are documented with their subsystems.

## Documentation

- `AGENTS.md` — repository map, safety boundaries, commands, and contribution
  workflow
- `gui/README.md` — loopback API contract
- `ui/` — React control panel and the real-server contract suite
- `kernel/README.md` — bounded task-runner contract
- `runner/README.md` — directive-runner contract

New work is tracked in GitHub Issues. Pull requests are verified by the
repository's `PR Gate` workflow.
