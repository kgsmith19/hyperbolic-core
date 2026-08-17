# tools/

Two unrelated things live here: the quality gate that runs before a merge, and
the OS-level fix scripts for the problems `network-checker diagnose` can already name.

Every claim below was checked against the scripts. Where a capability is
partial, it says so — this file previously promised rollback for all three
fixes and a JSON output mode, neither of which existed.

## The gate

```bash
bash tools/check.sh
```

Runs the test suite, the three scanners below at the configured intensities,
and `bash -n` over every shell script. It prints PASS/FAIL per step and exits
non-zero if any failed. The hyperbolic-core root's
`.github/workflows/toolbelt-ci.yml` runs this same script from this
directory, so local and CI use the same checks.

### The three scanners

Each takes a path, an `-i` intensity, and `-f text|json`; each exits 1 if it
found anything and 0 if it did not.

| Tool | Finds | Intensities |
|---|---|---|
| `code_simplification.py` | Functions over the length, parameter, complexity, or nesting ceiling | `low` 100 lines / 8 params / cx 15 / nest 5 · `medium` 40 / 4 / 8 / 3 · `high` 15 / 3 / 6 / 2 |
| `security_review.py` | Hardcoded secrets, `eval`/`exec`, `pickle`/`yaml.load`, `subprocess(shell=True)` | `high` adds generic-secret and URL-credential patterns |
| `documentation_check.py` | Missing README sections, template artifacts, scaffold files | `high` adds public functions with no docstring |

`medium` is the complexity profile used by `check.sh`. `low` is intended for
exploration and is not part of `Verify: Tests (Toolbelt)`.

```bash
python tools/code_simplification.py network-checker -i medium
python tools/security_review.py . -i high
python tools/documentation_check.py . -i high -f json
```

## The fix scripts

The scripts below are executors now, not entry points. Run them only through
the change lifecycle (`network_checker/change.py`, docs/planning/05-f-network-checker.md
section 4): every device write needs a recorded dry run and an explicit,
interactive approval, and a failed post-apply verification triggers an
automatic rollback to the pre-approved inverse. There is no more unattended
`run_fixes.sh` wrapper — its dry-run and ordering roles are subsumed by
`change test` and per-change records.

```bash
python -m network_checker change propose --title <t> --cmd <script> --inverse <inverse> --verify <probe-expr>
python -m network_checker change test <id>       # dry-run: measures verify_probe, never mutates
python -m network_checker change show <id>       # review the exact commands and dry-run evidence
python -m network_checker change approve <id>    # interactive only; refuses if stdin is not a TTY
python -m network_checker change apply <id> --token <token>
```

`network_checker/change_templates.py` seeds three ready-to-propose templates, one
per script below; `rank._fix()` recommends the matching template's exact
`change propose` invocation whenever a ranked cause has one.

| Script | Problem | Detects with | Applies | Inverse |
|---|---|---|---|---|
| `fix_dns.sh` | The local resolver (usually the router) is failing | `nslookup`, `/etc/resolv.conf` | Public resolvers `1.1.1.1`, `8.8.8.8`, via systemd-resolved, `/etc/resolv.conf`, or `netsh` | `--restore`: `/etc/resolv.conf.bak` if that mechanism was used; else the drop-in's real captured pre-change content (or its genuine absence) |
| `fix_wifi_mode.sh` | Adapter pinned below its capability | `iw dev`, `iw phy` | Raises the mode where the driver allows it | `--restore`: the real captured pre-change tx-power, re-pinned via `iw ... set txpower fixed <mBm>`; `auto` only if nothing was ever captured |
| `fix_adapter_power.sh` | Power saving drops the link | `ethtool` wake-on-LAN, `iw ... get power_save` | Turns power saving off, enables WoL | `--restore`: the real captured pre-change `power_save` state and Wake-on-LAN flags, both restored independently |

Each script's own `capture_state`/`--capture-state` records the concrete
pre-change value the first time its forward path runs on a host (kept
until explicitly re-captured with `--force`, since `change apply` only
ever calls it once per approved change); `restore_state`/`--restore` is
what `network_checker/change_templates.py`'s `inverse_cmd` now invokes. 05-f
section 4.5's Finding 18 has the full accounting of what this closed and
what it didn't -- specifically that `change test`'s dry-run still has no
way to surface the captured value as evidence before approval, a `change.py`
change out of this script-level fix's scope.

Post-apply verification for `wifi_mode` and `adapter_power` no longer
reuses a bare gateway ping: `network_checker/linux_adapter_probes.py` measures the
actual property each change claims to modify (tx power vs. this radio's own
ceiling; `power_save`/WoL together) and change_templates.py's `verify_probe`
reads that measurement directly.

An unreachable gateway has no automated fix. It is a hardware, cabling, or ISP
problem, and no config write from this machine addresses it.

### What these cannot do

- Fix anything upstream of your equipment: ISP faults, DOCSIS line quality,
  carrier NAT.
- Fix hardware: a failing Wi-Fi card, a bad cable.
- Supply Wi-Fi credentials.
- Run natively on Windows or macOS. These are Linux shell scripts;
  `scripts/*.ps1` are the Windows equivalents.

## The rest

| File | Does |
|---|---|
| `check.sh` | The gate above |
| `deploy.sh` | Runs the gate, builds the Docker image, smoke-tests it, saves a tarball |
| `release.py` | `bump major|minor|patch` and `changelog` (drafts entries from git log) |
| `scan_cli.py` | Shared argparse/output plumbing the three scanners above import -- not run directly |

See `docs/notes/2026-08-07-deploying-and-releasing-network-checker.md` for the
release procedure these two are part of.
