Title: FEAT(brain): programmatic API, SSE stream, and lossless replay
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-08-feat-brain-daemon-state.md, m4-12-feat-brain-autonomy-approvals.md
Blocks: m4-16-feat-shell-brain-surface.md, m4-20-feat-brain-lifeos-forwarding.md

## Problem
BR-4 requires streaming progress that survives reconnect without losing run state; the transport is SSE with typed events replayed from the append-only journal, and the route and auth surface is 07-brain-architecture.md sections 7.6 and 7.8 (programmatic).

## Scope
In scope:
- Per-run append-only ndjson event journal, flushed per event
- Routes: POST /api/brain/runs, GET /api/brain/runs/{id}, GET /api/brain/runs/{id}/events (SSE, typed events, 15 s heartbeat, Last-Event-ID resume), approve/reject routes, GET /api/brain/health
- Auth per ADR-03: operator session JWT or scoped agent token; brain:run:propose forces autonomy <= 1
- TypeScript client in packages/platform-client
Out of scope:
- UI consumption (m4-16); LifeOS-side wiring (m4-20)

## Acceptance criteria
When a client reconnects with Last-Event-ID after any gap, the stream shall replay losslessly from the journal.
If a request reaches any /api/brain/* route without a valid credential, then the system shall respond 401 within 50 ms (SH-4 for this API base).
When a run is created with the brain:run:propose scope, any autonomy above 1 shall park for approval.
Control-plane calls shall answer within 200 ms p95 and events shall deliver within 500 ms p95 of journal write.

## Verification
Integration test: start run, drop the socket mid-stream, reconnect with Last-Event-ID, assert the event sequence is gap-free against the journal file
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' http://127.0.0.1:8100/api/brain/runs returns 401 under 0.05
Scoped-token test: propose-scope run at autonomy 2 parks
Latency assertions in the API test suite (50-call p95)

## Estimated LOC delta
Added: 700  Deleted: 0  Net: +700

## Risk
Medium; the journal is the reconnect source of truth, so flush ordering bugs surface here.
