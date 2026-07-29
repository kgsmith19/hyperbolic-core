"""Calendar domain (ADR 012): read-only ICS ingestion with source receipts.

Types are registry data (zero kernel DDL, invariant 1); every state change
goes through kernel application services (invariant 7). Entry point:
``python -m domains.calendar.ingest`` under a code-built AccessContext of
exactly ``calendar:read`` + ``calendar:write``.
"""
