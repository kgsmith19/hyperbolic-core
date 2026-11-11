#!/usr/bin/env bash
# Nightly backup on hyperbolic-core-prod (#562), run by hyperbolic-core-backup.timer.
# 1. Consistent SQLite + blob snapshot via ops/store_ops.py (online backup API,
#    integrity-checked), into /srv/hyperbolic-core/backups/<ts>; 7 kept locally.
# 2. restic (encrypted, deduplicated) copy of that snapshot plus env/ to the
#    Hetzner Storage Box "hyperbolic-backups"; keeps 7 daily, 4 weekly, 6 monthly.
# 3. A restore drill of the newest local snapshot (store_ops.py restore-drill).
set -euo pipefail
BASE=/srv/hyperbolic-core
ts="$(date -u +%Y%m%dT%H%M%SZ)"
cd "$(readlink -f "$BASE/current")"
python3 ops/store_ops.py backup "$BASE/backups/nightly-$ts" >/dev/null
python3 ops/store_ops.py restore-drill "$BASE/backups/nightly-$ts" --report "$BASE/backups/restore-drill.json" >/dev/null
ls -1dt "$BASE"/backups/nightly-*/ | tail -n +8 | xargs -r rm -rf
ls -1dt "$BASE"/backups/predeploy-*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
if [[ -f "$BASE/env/restic.env" ]]; then
  set -a; . "$BASE/env/restic.env"; set +a
  restic snapshots --latest 1 >/dev/null 2>&1 || restic init >/dev/null
  restic backup --tag hyperbolic-core --host hyperbolic-core-prod "$BASE/backups/nightly-$ts" "$BASE/env" >/dev/null
  restic forget --tag hyperbolic-core --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune >/dev/null
  echo "backup: $ts stored locally and off-host (restic)"
else
  echo "backup: $ts stored locally; restic.env missing, no off-host copy" >&2
  exit 1
fi
