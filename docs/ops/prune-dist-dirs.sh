#!/usr/bin/env bash
# Prunes old versioned deploy directories (dist-<sha>) on a deploy host,
# keeping the newest N, for docs/planning/10-cicd-deployment.md section 2.2
# ("Activation: ... prune to the newest 3 dist-* dirs") and section 8.2
# (rollback: "ln -sfn dist-<prior-sha> shell/current; no rebuild, no
# network, seconds of exposure").
#
# WHY THIS IS ITS OWN SCRIPT, NOT AN INLINE `run:` STEP (m2-07 issue's own
# risk-mitigation instruction: externalize anything with real branching
# logic that a one-off off-by-one bug could silently break): pruning is the
# one piece of this pipeline that permanently deletes data. An off-by-one
# here either (a) deletes the build a human just rolled back to via
# section 8.2's manual symlink repoint, silently undoing their rollback the
# next time this script runs, or (b) never deletes anything, leaking disk
# forever. Both failure modes are exactly the kind of bug that is easy to
# write, easy to miss in review, and expensive to discover live -- so this
# logic gets a real red/green test (prune-dist-dirs.test.mjs) against a
# real temp filesystem instead of only being exercised for the first time
# against the actual deploy host.
#
# .github/workflows/deploy.yml's deploy-shell job scp's this exact file to
# the host and runs it there over ssh (the same file this test exercises
# locally -- no parallel/duplicated prune logic living only in YAML).
#
# CONTRACT:
#   - Keeps the newest <keep-count> dist-* directories by mtime (default 3,
#     docs/planning/10-cicd-deployment.md section 2.2's "prune to the
#     newest 3 dist-* dirs").
#   - ALSO always keeps whatever the `current` symlink resolves to, even if
#     that directory falls outside the newest <keep-count> by mtime. This
#     is deliberately stronger than the spec's literal "newest 3" wording:
#     it defends against the concrete scenario where an operator manually
#     rolled back `current` to an older dist-<sha> (section 8.2) and this
#     script later runs again (e.g. the operator re-dispatches deploy-shell
#     for an unrelated reason, or a future ops task calls this script on
#     its own) before a fresh deploy has re-established that directory as
#     the newest -- without this rule, pruning could delete the exact
#     directory a human just deliberately rolled back to. In the normal
#     single-deploy flow (mv new dir in, then `ln -sfn` it as `current`,
#     then prune) this branch never fires: `current` is always the newest
#     dir at prune-time. It exists as a safety net, not a load-bearing part
#     of the ordinary deploy path, and is documented as such rather than
#     oversold as required by the base spec.
#   - Never touches the `current` symlink itself, only dist-* directories.
#   - No-op (nothing deleted) when there are <= <keep-count> directories.
#
# Usage: prune-dist-dirs.sh <base-dir> [keep-count]
#   base-dir must contain zero or more "dist-*" directories and, optionally,
#   a `current` symlink pointing at one of them (e.g. /home/deploy/shell).
#   keep-count defaults to 3.

set -euo pipefail

base_dir="${1:?usage: prune-dist-dirs.sh <base-dir> [keep-count]}"
keep="${2:-3}"

if [ ! -d "$base_dir" ]; then
  echo "error: $base_dir is not a directory" >&2
  exit 1
fi

case "$keep" in
  '' | *[!0-9]*)
    echo "error: keep-count must be a non-negative integer, got: $keep" >&2
    exit 1
    ;;
esac

cd "$base_dir"

# Newest-first by mtime (matches the "prune to the newest N" framing
# directly, rather than sorting oldest-first and inverting later). `find
# -printf` (GNU findutils, present on both this repo's ubuntu-latest
# runners and any realistic Debian/Ubuntu deploy host) instead of `ls -t`
# deliberately: shellcheck SC2012 flags `ls` for sorted-filename parsing
# because it mishandles unusual characters in filenames; `find -printf`
# with an explicit numeric epoch field sidesteps that class of bug
# entirely rather than accepting the known footgun. When nothing matches,
# find's output is simply empty (not an error), so no `|| true` is needed
# here the way the `ls` form required one.
mapfile -t dirs < <(find . -maxdepth 1 -mindepth 1 -type d -name 'dist-*' -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2-)

current_target=""
if [ -L current ]; then
  current_target="$(basename "$(readlink current)")"
fi

# Directories to keep: the newest <keep> by mtime, plus (if not already
# among them) whatever `current` points at. Built as a simple membership
# array; directory counts here are small (single digits in practice), so
# the O(n^2) membership checks below cost nothing real.
keep_set=()
for i in "${!dirs[@]}"; do
  if [ "$i" -lt "$keep" ]; then
    keep_set+=("${dirs[$i]}")
  fi
done

if [ -n "$current_target" ]; then
  already_kept=0
  for d in "${keep_set[@]:-}"; do
    if [ "$d" = "$current_target" ]; then
      already_kept=1
      break
    fi
  done
  if [ "$already_kept" -eq 0 ]; then
    keep_set+=("$current_target")
  fi
fi

pruned_any=0
for d in "${dirs[@]:-}"; do
  [ -z "$d" ] && continue
  should_keep=0
  for k in "${keep_set[@]:-}"; do
    if [ "$d" = "$k" ]; then
      should_keep=1
      break
    fi
  done
  if [ "$should_keep" -eq 0 ]; then
    echo "pruning $d"
    rm -rf -- "$d"
    pruned_any=1
  fi
done

if [ "$pruned_any" -eq 0 ]; then
  echo "nothing to prune"
fi
