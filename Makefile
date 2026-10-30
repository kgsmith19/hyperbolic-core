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

.PHONY: up down init test backup restore-drill release rollback status

up:
	docker compose up -d --build --wait

down:
	docker compose down

# Writes services/platform-api/.env (the owner key and JWT key). Run once.
init:
	npm run init --workspace=@hyperbolic/platform-api

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

# Tags the clean HEAD if the health gate passes. A failure tags nothing.
release:
	@test -n "$(NAME)" || { echo "usage: make release NAME=v1"; exit 2; }
	python3 ops/release.py tag $(NAME) --health "$(HEALTH)"

# Returns to the previous tagged release. Leaves HEAD detached at that SHA;
# run `git checkout main` to go back to the branch.
rollback:
	python3 ops/release.py rollback --health "$(HEALTH)" \
	  --deploy "git checkout -q --detach {sha} && docker compose up -d --build --wait"

status:
	python3 ops/release.py status
