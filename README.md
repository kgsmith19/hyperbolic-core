# Agentic Command Center

Agentic Command Center (ACC) is a local guard rail and control panel for
Claude Code. It protects selected files and secrets, provides a loopback web
interface, runs bounded headless tasks, and carries directives across fresh
contexts.

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
```

## Verify

```bash
npm test
npm run covgate
npm run test:windows
npm run e2e:gui
```

`npm run test:windows` and the PowerShell suites require Windows. Real-token
proof commands are manual and are documented with their subsystems.

## Documentation

- `AGENTS.md` — repository map, safety boundaries, commands, and contribution
  workflow
- `gui/README.md` — loopback API contract
- `kernel/README.md` — bounded task-runner contract
- `runner/README.md` — directive-runner contract
- `docs/SYSTEM-REQUIREMENTS.md` — implemented system requirements
- `docs/DATA-FLOW-DIAGRAM.md` — data flows and trust boundaries
- `docs/adr/` — product architecture decisions
- `specs/TEST-LEDGER.md` — historical test rationale

New work is tracked in GitHub Issues. Pull requests are verified by the
repository's `PR Gate` workflow.
