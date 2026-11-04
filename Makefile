# Local, cloud-free entry points (#504). Every target runs on a clean clone
# with no cloud credentials. `up` and `rollback` need Docker; the rest need
# only Node 22 and Python 3.12. State (backups, release log) lives in var/,
# which is git-ignored.

SHELL := /bin/bash
TS := $(shell date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR ?= var/backups/$(TS)
# The health gate a build must pass before it is tagged. Overridable.
HEALTH ?= make test
NAME ?=
export HOST_UID ?= $(shell id -u)
export HOST_GID ?= $(shell id -g)

.PHONY: up down init policy test backup restore-drill canary telemetry release verify rollback status

up: policy init
	@mkdir -p var/platform var/network-checker var/lifeos/blobs var/brain/home var/brain-workspaces
	docker compose up -d --build --wait

# The broker's deny-by-default policy, generated from every tool.json.
policy:
	@mkdir -p var/broker
	npm run --silent broker-policy:generate -- --out var/broker/broker-policy.json

down:
	docker compose down

# Local identities, generated once and never committed (#504). platform-api's
# .env holds the owner and JWT keys; LifeOS's .env points its auth at that
# platform. Both use http://platform.localhost:8400: browsers resolve
# *.localhost to loopback, and inside compose it is platform-api's alias, so
# the token issuer matches from either side.
PLATFORM_URL := http://platform.localhost:8400
init: services/platform-api/.env apps/lifeos/backend/.env

services/platform-api/.env:
	npm run --silent init --workspace=@hyperbolic/platform-api -- --public-url $(PLATFORM_URL)

apps/lifeos/backend/.env: services/platform-api/.env
	@owner=$$(sed -n 's/^PLATFORM_OWNER_ID=//p' services/platform-api/.env); \
	test -n "$$owner" || { echo "PLATFORM_OWNER_ID missing from services/platform-api/.env"; exit 1; }; \
	umask 077; printf 'LIFEOS_PLATFORM_URL=%s\nLIFEOS_OWNER_USER_ID=%s\n' "$(PLATFORM_URL)" "$$owner" > $@
	@echo "wrote $@"

# The fast local gate: every workspace suite that needs no Postgres and no
# hosted service, plus the ops and docs oracles.
test:
	npm test --workspace=@hyperbolic/manifest-tools
	npm test --workspace=@hyperbolic/hyp-cli
	npm test --workspace=@hyperbolic/platform-api
	python3 -m unittest discover -s ops -p 'test_*.py'
	node --test docs/ops/*.test.mjs

backup:
	python3 ops/store_ops.py backup $(BACKUP_DIR)

# Restores the newest backup into a scratch directory and proves it.
restore-drill:
	@dir=$$(ls -1d var/backups/*/ 2>/dev/null | sort | tail -1); \
	test -n "$$dir" || { echo "no backup yet: run make backup"; exit 1; }; \
	python3 ops/store_ops.py restore-drill "$$dir" --report var/restore-drill.json

# A canary stack on shifted ports, health-checked and torn down (#504).
canary: policy init
	ops/canary.sh

# One JSON health report for every running service; fails if any is unhealthy.
telemetry:
	python3 ops/telemetry.py

# The full local release (#504, AC3): canary, deploy, then health, invariant
# (backup plus restore drill) and telemetry. Any failure after the deploy
# rolls back to the previous live release and tags nothing. A healthy build
# gets a signed attestation, then the release tag at its exact SHA.
DEPLOY ?= git checkout -q --detach {sha} && $(MAKE) up
INVARIANT ?= $(MAKE) backup && $(MAKE) restore-drill
TELEMETRY ?= python3 ops/telemetry.py
CANARY ?= ops/canary.sh
release: policy
	@test -n "$(NAME)" || { echo "usage: make release NAME=v1"; exit 2; }
	python3 ops/release.py tag $(NAME) --health "$(HEALTH)" --canary "$(CANARY)" \
	  --deploy "$(DEPLOY)" --invariant "$(INVARIANT)" --telemetry "$(TELEMETRY)"

# Re-checks a release's signed attestation against the repository.
verify:
	@test -n "$(NAME)" || { echo "usage: make verify NAME=v1"; exit 2; }
	python3 ops/release.py verify $(NAME)

# Returns to the previous tagged release. Leaves HEAD detached at that SHA;
# run `git checkout main` to go back to the branch.
rollback:
	python3 ops/release.py rollback --health "$(HEALTH)" \
	  --deploy "$(DEPLOY)"

status:
	python3 ops/release.py status
