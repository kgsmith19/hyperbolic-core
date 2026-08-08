# health_connect cell

Owns: `src/domains/health_connect/**`, `tests/health_connect/**`.

## Purpose

H1 slice: receive Android Health Connect data via the Health Connect Webhook app
(`com.hcwebhook.app`, open source at `mcnaveen/health-connect-webhook`). The app
reads Google Health Connect on-device and POSTs to `POST /health-connect`. A Withings
scale is the weight source: Withings Health Mate → Google Health Connect sync →
HC Webhook push. Activity (steps, exercise sessions) comes from the phone's sensor
hub and any paired workout app.

## Types

- **weight_measurement** — one scale reading; identity: `content_hash` (sha256 of
  metric+time+kg); stores kilograms as-is (convert at read, never mutate at edge).
- **activity_summary** — one exercise session; identity: `content_hash` (sha256 of
  type+start_time+duration_seconds).

No PII fields in either type: weight and timestamps are not personal-identifying in
the GDPR sense as standalone records, and Health Connect carries no free text.

## Idempotency Contract

The HC Webhook app carries NO per-record id and sends a rolling 48-hour window on
every delivery plus retries. Duplicate delivery is **the normal case**, not a
pathology. Content-hash identity keys make every capture a silent upsert — replaying
the same window emits zero new events.

## Auth

Shared secret in the `X-HC-Secret` request header (set as a custom header in the
HC Webhook app's webhook URL configuration). Secret stored in `LIFEOS_HC_SECRET` env
var. No JWT: the Android app cannot hold a user token. Rotation documented in
`docs/runbook.md`.

## Access Control

Endpoint uses `AccessContext.of("health_connect:read", "health_connect:write")` — no
owner-level access from the webhook path. Ingestion is push-only; there is no
scheduled pull (ADR 019).

## Constraints

- Zero kernel DDL (invariant 1).
- All writes through kernel services (invariant 7).
- Reject unknown fields within `weight` / `exercise` arrays; ignore unknown top-level
  arrays (forward compatibility with future HC data types).
- No sleep data (CPAP/H2 owns sleep signal).
- No trend math, no charts (D1 owns trends).
- No second health data source: one ingestion path, hardware-agnostic.
- Weight in kilograms at the edge — never convert or mutate on ingestion.

## Weight Source Status (2026-08-08)

The previously-owned scale's app was broken. A Withings scale is on order. Until it
arrives, `MOCK_PAYLOAD` in `domains.health_connect.ingest` provides a faithful replica
of the expected webhook payload for development and CI. Activity data is unaffected
— it comes from the phone's step counter and is available now.

## Risk

R1 — local, reversible. Weight ingestion is blocked on hardware arrival, not design.
Activity ingestion ships without the hardware dependency.
