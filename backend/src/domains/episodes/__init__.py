"""Episodes domain (roadmap EP1): the operator's own episode log and playbook.

Types are registry data (zero kernel DDL, invariant 1); every state change goes
through kernel application services (invariant 7). Both types are x-sensitive
from their first definition (ADR 016) — this domain never reaches a model
through the shared agent-tool surface. Pull-only by decision: no notification
path may exist in code; no prediction, no risk scores, no physiology
dashboards, no push prompts, no exposure coaching, no clinical advice.
"""
