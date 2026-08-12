# tools/

Two unrelated things live here: the quality gate that runs before a merge, and
the OS-level fix scripts for the problems `netcheck diagnose` can already name.

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
exploration and is not part of the Toolbelt PR Gate.

```bash
python tools/code_simplification.py netcheck -i medium
python tools/security_review.py . -i high
python tools/documentation_check.py . -i high -f json
```

## The fix scripts

```bash
sudo bash tools/run_fixes.sh --dry-run    # print what would change, change nothing
sudo bash tools/run_fixes.sh              # apply all three
sudo bash tools/run_fixes.sh --dns-only   # or --wifi-only, --adapter-only
sudo bash tools/run_fixes.sh -v           # verbose; also VERBOSE=1
```

`--dry-run` is the only mode that does not need root. `FIX_WIFI`, `FIX_DNS`,
and `FIX_ADAPTER` (`0`/`1`) select fixes from the environment instead of flags.

Each script detects first, applies only if it found the problem, then
re-checks — so running them on a healthy machine changes nothing.

| Script | Problem | Detects with | Applies |
|---|---|---|---|
| `fix_dns.sh` | The local resolver (usually the router) is failing | `nslookup`, `/etc/resolv.conf` | Public resolvers `1.1.1.1`, `8.8.8.8`, via systemd-resolved, `/etc/resolv.conf`, or `netsh` |
| `fix_wifi_mode.sh` | Adapter pinned below its capability | `iw dev`, `iw phy` | Raises the mode where the driver allows it |
| `fix_adapter_power.sh` | Power saving drops the link | `ethtool` wake-on-LAN, `iw ... get power_save` | Turns power saving off, enables WoL |

**Rollback is DNS only.** `fix_dns.sh` copies `/etc/resolv.conf` to
`/etc/resolv.conf.bak` before writing and restores it if resolution still
fails afterwards. `fix_wifi_mode.sh` and `fix_adapter_power.sh` do not back up
or restore anything — verify with `--dry-run` first.

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

See `docs/notes/2026-08-07-deploying-and-releasing-netcheck.md` for the
release procedure these two are part of.
