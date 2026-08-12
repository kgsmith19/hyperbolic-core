Title: CHORE(ci): Brain and Handler A deploy units
Type: CHORE
Component: hyperbolic-core
Milestone: M4 The Brain
Depends on: m4-08-feat-brain-daemon-state.md, m4-05-feat-llm-handler-service.md, m4-18-feat-brain-security-redaction.md, m2-07-chore-ci-deploy-shell.md
Blocks: none

## Problem
BR-6 requires the deployed Brain to start with one command and report health, and Handler A needs its own unit pipeline; specs are 10-cicd-deployment.md sections 2.3, 2.4, 3.2, and 3.3, with key isolation mechanics from ADR-05.

## Scope
In scope:
- services/brain/Dockerfile per the 10 section 3.2 multi-stage spec (non-root brain user) and the brain compose skeleton per 3.3
- deploy.yml jobs build-brain/deploy-brain and build-llm-handler/deploy-llm-handler per 10 sections 2.3 and 2.4, with disjoint Infisical identities (/brain/ vs /platform/llm/) and separate compose project directories
- tailscale serve route for /brain/stream
- Image retention rule (keep newest 3) and documented rollback per 10 sections 8.3 and 8.3b
Out of scope:
- LifeOS pipeline (standalone repo); the accidental-publish hazard image name (this publishes only the deliberate brain and llm-handler image names)

## Acceptance criteria
When deploy.yml runs for a Brain change, the deployed container shall pass compose --wait and the health curl shall return 200 (BR-6 deployed form).
The Handler A identity shall be unable to read /brain/, and the Brain identity unable to read /platform/llm/ (isolation check per path).
Rollback by repointing the image tag in the unit .env shall complete within 5 minutes without touching state volumes.
Each unit shall deploy only when its paths changed, under its own concurrency group.

## Verification
gh workflow run deploy.yml; ssh health curls return 200 for 127.0.0.1:8100/healthz and 127.0.0.1:8200/healthz
ADR-05 isolation checks run under each identity; cross-path reads exit non-zero
Timed rollback drill per 10 section 8.3; brain-state volume checksum unchanged
Two pushes touching disjoint unit paths; run graphs show only the owning unit jobs

## Estimated LOC delta
Added: 350  Deleted: 0  Net: +350

## Risk
Medium; first container publishes from the monorepo root, deliberately gated inside deploy.yml only.
