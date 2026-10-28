#!/usr/bin/env bash
# Evaluates G2-declared canary invariants from real telemetry (G3, #407).
#
# Inputs (all env): GH_TOKEN, REPO, SHA, SMOKE_RESULT, plus one *_RESULT per
# unit (SHELL_RESULT, LLM_HANDLER_RESULT, BRAIN_RESULT, BROKER_RESULT,
# BACKEND_RESULT, UI_RESULT — "success" means the unit shipped this run).
#
# Decision table per shipped unit:
#   - Declaration missing (no docs/ops/canary/<unit>.canary.yml) → FAIL
#     CLOSED (the canary cannot be observed because it was never declared).
#   - Canary Release missing (canary/<unit>/<date>-<sha> absent via the
#     releases API) → FAIL CLOSED (the per-release stamp never landed).
#   - Any smoke-anchored invariant and SMOKE_RESULT != success → FAIL
#     (breach: the live verdict the invariant names is red).
#   - Non-smoke signals (G3-telemetry latency/error-rate) → UNOBSERVED
#     (reported, never green-claimed; see canary-observe.yml header).
#   - Otherwise → PASS for the unit.
#
# Any FAIL exits non-zero: the breach is visible and promotion halts.
# TAG_RELEASE_DATE override follows the tag-release.sh convention for tests.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${REPO:?REPO must be set (owner/repo)}"
: "${SHA:?SHA must be set}"
: "${SMOKE_RESULT:?SMOKE_RESULT must be set}"

date_tag="${TAG_RELEASE_DATE:-$(date -u +%Y%m%d)}"
short_sha="${SHA:0:12}"

declare -A UNIT_RESULTS=(
  [shell]="${SHELL_RESULT:-skipped}"
  [llm-handler]="${LLM_HANDLER_RESULT:-skipped}"
  [brain]="${BRAIN_RESULT:-skipped}"
  [broker]="${BROKER_RESULT:-skipped}"
  [lifeos-backend]="${BACKEND_RESULT:-skipped}"
  [lifeos-ui]="${UI_RESULT:-skipped}"
)

failures=0
breaches=()
unobserved=()

# A signal counts as smoke-anchored when the declaration names the smoke
# suite (platform-smoke), a probe, or a container-local check the smoke run
# covers. Everything else is a G3-telemetry signal (unobserved in this slice).
is_smoke_signal() {
  local signal="$1"
  [[ "$signal" =~ [Ss]moke ]] || [[ "$signal" =~ [Pp]robe ]] || [[ "$signal" =~ container-local ]] || [[ "$signal" =~ loopback ]]
}

canary_signals() {
  local unit="$1"
  grep -E '^    signal: ' "docs/ops/canary/${unit}.canary.yml" | sed 's/^    signal: //'
}

for unit in shell llm-handler brain broker lifeos-backend lifeos-ui; do
  result="${UNIT_RESULTS[$unit]}"
  if [[ "$result" != "success" ]]; then
    echo "skip ${unit}: deploy result was '${result}' (did not ship)"
    continue
  fi
  echo "=== observing canary for shipped unit: ${unit} ==="

  # 1. Declaration must exist.
  if [[ ! -f "docs/ops/canary/${unit}.canary.yml" ]]; then
    echo "::error::canary-missing for ${unit}: shipped with no declaration (docs/ops/canary/${unit}.canary.yml absent) — FAIL CLOSED" >&2
    failures=$((failures + 1))
    continue
  fi

  # 2. Per-release stamp must exist (fails closed on missing series).
  release_tag="canary/${unit}/${date_tag}-${short_sha}"
  status="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/releases/tags/${release_tag}")"
  if [[ "$status" == "404" ]]; then
    echo "::error::missing-telemetry for ${unit}: canary release ${release_tag} absent — the per-release stamp never landed — FAIL CLOSED" >&2
    failures=$((failures + 1))
    continue
  fi
  if [[ "$status" != "200" ]]; then
    echo "::error::unexpected HTTP ${status} checking canary release ${release_tag} — FAIL CLOSED" >&2
    failures=$((failures + 1))
    continue
  fi
  echo "ok   ${unit}: canary release ${release_tag} present"

  # 3. Evaluate smoke-anchored invariants against the live smoke verdict.
  while IFS= read -r signal; do
    inv_name="$(grep -B1 -F "signal: ${signal}" "docs/ops/canary/${unit}.canary.yml" | grep -oE 'name: .*' | head -1 | sed 's/name: //')"
    if is_smoke_signal "$signal"; then
      if [[ "$SMOKE_RESULT" != "success" ]]; then
        echo "::error::invariant-breach for ${unit}/${inv_name}: smoke verdict is '${SMOKE_RESULT}' — HALT" >&2
        breaches+=("${unit}/${inv_name}")
        failures=$((failures + 1))
      else
        echo "ok   ${unit}/${inv_name}: smoke-anchored signal green (smoke=${SMOKE_RESULT})"
      fi
    else
      echo "::notice::unobserved ${unit}/${inv_name}: signal '${signal}' has no telemetry pipeline yet (G3 follow-up) — reported, never green-claimed"
      unobserved+=("${unit}/${inv_name}")
    fi
  done < <(canary_signals "$unit")
done

echo ""
echo "--- canary observation summary ---"
echo "breaches: ${#breaches[@]}"
echo "unobserved: ${#unobserved[@]}"
if [[ "${#unobserved[@]}" -gt 0 ]]; then
  printf 'unobserved: %s\n' "${unobserved[@]}"
fi

if [[ "$failures" -gt 0 ]]; then
  printf '::error::canary-observe: %s failure(s) — promotion HALTED\n' "$failures" >&2
  if [[ "${#breaches[@]}" -gt 0 ]]; then
    printf '::error::breached: %s\n' "${breaches[@]}" >&2
  fi
  exit 1
fi
echo "canary-observe: all shipped units green on smoke-anchored invariants (${#unobserved[@]} unobserved G3-telemetry signal(s) disclosed above)"
