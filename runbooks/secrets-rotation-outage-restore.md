# Secrets Rotation / Outage / Restore Drill Runbook (INT-09 #397)

Metadata-only throughout: proofs record handles, scopes, and timestamps —
never values. Drills must not alter existing rotation state.

## Rotation drill

1. Pick one consumer row from `inventories/secrets/INVENTORY.md`.
2. Confirm the live handle still resolves (consumer workflow green on its
   secret-path scope).
3. Record proof: handle + scope + timestamp + consumer workflow run URL.

## Outage drill

1. Simulate federation denial for one role (deny flag, no credential reads).
2. Confirm resolution fails closed with the denial reason surfaced.
3. Record proof: role + denial reason + timestamp. No owner fallback.

## Restore drill

1. After the outage drill, clear the deny flag.
2. Confirm the consumer returns to its pre-change metadata state
   (same handle, same scope, same location row).
3. Record proof: pre/post metadata comparison (handles only).

## Proof format (per live change)

`{handle, scope, change: rotation|outage|restore, at: <UTC>, run: <url>, result: intact}`

A failed proof on any live change halts further per-consumer children
until resolved.
