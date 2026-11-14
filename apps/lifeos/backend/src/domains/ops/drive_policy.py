"""LifeOS Google Docs/Sheets storage-policy enforcement (P-60, #636)."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Protocol

GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
MAX_MANIFEST_DOCUMENTS = 500
MAX_CONTENT_CHARS = 250_000
MAX_TABLE_CELLS = 50_000

WORKBOOK_OPERATIONS = "operations_registry"
WORKBOOK_DECISIONS = "owner_decisions"
WORKBOOK_MEDICATIONS = "medication_registry"

_QUESTIONNAIRE = re.compile(r"^\s*(?:answer|your answer)\s*:\s*.*$", re.IGNORECASE)
_CHANGELOG_HEADING = re.compile(
    r"^\s*(?:#{1,6}\s*)?(?:change log|changelog|recent changelog)\s*$", re.IGNORECASE
)
_DATED_ENTRY = re.compile(r"^\s*\d{4}-\d{2}-\d{2}\b.*(?:\||—|-)\s*\S+")
_RECORD_ROW = re.compile(
    r"^\s*\|?\s*(?P<record_key>(?P<prefix>P|MB|DEC|MED|ENT|REL|LOC|OBL|EVT|WF|SRC|TECH|SYS)"
    r"-[A-Za-z0-9._-]+)\s*\|",
    re.IGNORECASE,
)
_RECORD_KEY = re.compile(
    r"^(?P<prefix>P|MB|DEC|MED|ENT|REL|LOC|OBL|EVT|WF|SRC|TECH|SYS)"
    r"-[A-Za-z0-9._-]+$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class _Route:
    rule_stem: str
    workbook: str
    sheet: str


_RECORD_ROUTES = {
    "P": _Route("task", WORKBOOK_OPERATIONS, "Task Registry"),
    "MB": _Route("manual_blocker", WORKBOOK_OPERATIONS, "Manual Blockers"),
    "DEC": _Route("decision", WORKBOOK_DECISIONS, "Decisions"),
    "MED": _Route("medication", WORKBOOK_MEDICATIONS, "Medication & Supplements"),
    "ENT": _Route("entity", WORKBOOK_OPERATIONS, "Entity Directory"),
    "REL": _Route("relationship", WORKBOOK_OPERATIONS, "Relationship Directory"),
    "LOC": _Route("location", WORKBOOK_OPERATIONS, "Location Directory"),
    "OBL": _Route("obligation", WORKBOOK_OPERATIONS, "Obligations Ledger"),
    "EVT": _Route("event", WORKBOOK_OPERATIONS, "Appointments & Events"),
    "WF": _Route("workflow", WORKBOOK_OPERATIONS, "Workflow Registry"),
    "SRC": _Route("source", WORKBOOK_OPERATIONS, "Source & Access"),
    "TECH": _Route("tech", WORKBOOK_OPERATIONS, "Tech & Setup Inventory"),
    "SYS": _Route("tech", WORKBOOK_OPERATIONS, "Tech & Setup Inventory"),
}

_HEADER_ROUTES: tuple[tuple[frozenset[str], _Route], ...] = (
    (frozenset({"task id", "status"}), _RECORD_ROUTES["P"]),
    (frozenset({"blocker id", "status"}), _RECORD_ROUTES["MB"]),
    (frozenset({"decision id", "status"}), _RECORD_ROUTES["DEC"]),
    (frozenset({"record id", "lifecycle / reported state"}), _RECORD_ROUTES["MED"]),
    (frozenset({"entity id", "status"}), _RECORD_ROUTES["ENT"]),
    (frozenset({"relationship id", "status"}), _RECORD_ROUTES["REL"]),
    (frozenset({"location id", "status"}), _RECORD_ROUTES["LOC"]),
    (frozenset({"obligation id", "status"}), _RECORD_ROUTES["OBL"]),
    (frozenset({"event id", "status"}), _RECORD_ROUTES["EVT"]),
    (frozenset({"workflow id", "status"}), _RECORD_ROUTES["WF"]),
    (frozenset({"source id", "status"}), _RECORD_ROUTES["SRC"]),
)


class ManifestShapeError(ValueError):
    """The caller supplied an unbounded or ambiguous Drive manifest."""


class RepairRefused(RuntimeError):
    """Expected state, authorization, or readback verification failed."""


class RepairPartialFailure(RepairRefused):
    """Automatic compensation could not finish; ``rollback_plan`` is safe to retry."""

    def __init__(self, message: str, rollback_plan: RollbackPlan) -> None:
        super().__init__(message)
        self.rollback_plan = rollback_plan


class RollbackPartialFailure(RepairRefused):
    """Rollback stopped after some actions; ``rollback_plan`` contains the remainder."""

    def __init__(self, message: str, rollback_plan: RollbackPlan) -> None:
        super().__init__(message)
        self.rollback_plan = rollback_plan


@dataclass(frozen=True)
class DriveTable:
    rows: tuple[tuple[str, ...], ...]


@dataclass(frozen=True)
class DriveDocument:
    file_id: str
    revision_id: str
    mime_type: str
    parent_ids: tuple[str, ...]
    content: str
    tables: tuple[DriveTable, ...] = ()


@dataclass(frozen=True)
class DriveManifest:
    documents: tuple[DriveDocument, ...]
    archive_parent_ids: frozenset[str]


@dataclass(frozen=True)
class Finding:
    file_id: str
    revision_id: str
    original_parent_ids: tuple[str, ...]
    rule: str
    workbook: str
    sheet: str
    line_number: int
    source_locator: str
    record_key: str | None
    evidence_fingerprint: str


@dataclass(frozen=True)
class SheetUpsert:
    stable_key: str
    workbook: str
    sheet: str
    source_file_id: str
    expected_revision_id: str
    evidence_fingerprint: str
    rule: str
    record_key: str
    source_locator: str
    rollback_mode: str


@dataclass(frozen=True)
class ArchiveProposal:
    file_id: str
    expected_revision_id: str
    original_parent_ids: tuple[str, ...]
    archive_parent_id: str
    rollback_mode: str


@dataclass(frozen=True)
class RepairPlan:
    actions: tuple[SheetUpsert, ...]
    archives: tuple[ArchiveProposal, ...]
    digest: str


@dataclass(frozen=True)
class RepairAuthorization:
    plan_digest: str
    approved_by: str
    allow_archive: bool = False


@dataclass(frozen=True)
class DocumentState:
    file_id: str
    revision_id: str
    parent_ids: tuple[str, ...]


@dataclass(frozen=True)
class SheetRecord:
    stable_key: str
    evidence_fingerprint: str
    field_names: tuple[str, ...] = ()
    field_values: tuple[str, ...] = ()


@dataclass(frozen=True)
class SourceRecord:
    record_key: str
    source_locator: str
    evidence_fingerprint: str
    field_names: tuple[str, ...]
    field_values: tuple[str, ...]


@dataclass(frozen=True)
class SheetWriteReceipt:
    stable_key: str
    evidence_fingerprint: str
    changed: bool


@dataclass(frozen=True)
class ArchiveReceipt:
    file_id: str
    preserved_revision_id: str
    previous_parent_ids: tuple[str, ...]
    current_parent_ids: tuple[str, ...]


@dataclass(frozen=True)
class SheetRollback:
    action: SheetUpsert
    written_fingerprint: str
    previous: SheetRecord | None


@dataclass(frozen=True)
class ParentRollback:
    proposal: ArchiveProposal


@dataclass(frozen=True)
class RollbackPlan:
    sheets: tuple[SheetRollback, ...]
    parents: tuple[ParentRollback, ...]
    digest: str


@dataclass(frozen=True)
class ResolveReceipt:
    plan_digest: str
    verified_sheet_records: int
    archived_file_ids: tuple[str, ...]
    rollback: RollbackPlan


@dataclass(frozen=True)
class RollbackAuthorization:
    plan_digest: str
    approved_by: str


@dataclass(frozen=True)
class RollbackReceipt:
    plan_digest: str
    restored_sheet_records: int
    restored_file_ids: tuple[str, ...]


class RepairAdapter(Protocol):
    def document_state(self, file_id: str) -> DocumentState: ...

    def read_source(self, action: SheetUpsert) -> SourceRecord: ...

    def upsert(self, action: SheetUpsert, source: SourceRecord) -> SheetWriteReceipt: ...

    def read_record(self, workbook: str, sheet: str, stable_key: str) -> SheetRecord | None: ...

    def archive(self, proposal: ArchiveProposal) -> ArchiveReceipt: ...

    def rollback_sheet(self, proposal: SheetRollback) -> SheetRecord | None: ...

    def restore_parents(self, proposal: ArchiveProposal) -> ArchiveReceipt: ...


@dataclass
class ConnectorRepairAdapter:
    """Concrete harness-neutral adapter for authorized Google connector bindings.

    The bindings own authenticated Drive/Docs/Sheets I/O. This class gives every harness the
    same resolver contract without accepting or storing a credential in LifeOS.
    """

    state_reader: Callable[[str], DocumentState]
    source_reader: Callable[[SheetUpsert], SourceRecord]
    sheet_upserter: Callable[[SheetUpsert, SourceRecord], SheetWriteReceipt]
    sheet_reader: Callable[[str, str, str], SheetRecord | None]
    archiver: Callable[[ArchiveProposal], ArchiveReceipt]
    sheet_rollback: Callable[[SheetRollback], SheetRecord | None]
    parent_restorer: Callable[[ArchiveProposal], ArchiveReceipt]

    def document_state(self, file_id: str) -> DocumentState:
        return self.state_reader(file_id)

    def read_source(self, action: SheetUpsert) -> SourceRecord:
        return self.source_reader(action)

    def upsert(self, action: SheetUpsert, source: SourceRecord) -> SheetWriteReceipt:
        return self.sheet_upserter(action, source)

    def read_record(self, workbook: str, sheet: str, stable_key: str) -> SheetRecord | None:
        return self.sheet_reader(workbook, sheet, stable_key)

    def archive(self, proposal: ArchiveProposal) -> ArchiveReceipt:
        return self.archiver(proposal)

    def rollback_sheet(self, proposal: SheetRollback) -> SheetRecord | None:
        return self.sheet_rollback(proposal)

    def restore_parents(self, proposal: ArchiveProposal) -> ArchiveReceipt:
        return self.parent_restorer(proposal)


@dataclass(frozen=True)
class RegisteredRepairOperation:
    operation_id: str
    risk: str


REGISTERED_REPAIR_OPERATIONS = {
    "lifeos.drive.docs-sheets-drift.v1": RegisteredRepairOperation(
        operation_id="lifeos.drive.docs-sheets-drift.v1",
        risk="R2",
    )
}


def prepare_registered(
    operation_id: str, manifest: DriveManifest, archive_parent_id: str
) -> RepairPlan:
    """Dispatch a registered check and materialize its digest-bound repair plan."""
    if operation_id not in REGISTERED_REPAIR_OPERATIONS:
        raise RepairRefused(f"repair operation {operation_id!r} is not registered")
    return plan_repairs(scan(manifest), archive_parent_id)


def apply_registered(
    operation_id: str,
    plan: RepairPlan,
    adapter: RepairAdapter,
    authorization: RepairAuthorization,
) -> ResolveReceipt:
    if operation_id not in REGISTERED_REPAIR_OPERATIONS:
        raise RepairRefused(f"repair operation {operation_id!r} is not registered")
    return resolve(plan, adapter, authorization)


def rollback_registered(
    operation_id: str,
    plan: RollbackPlan,
    adapter: RepairAdapter,
    authorization: RollbackAuthorization,
) -> RollbackReceipt:
    if operation_id not in REGISTERED_REPAIR_OPERATIONS:
        raise RepairRefused(f"repair operation {operation_id!r} is not registered")
    return rollback(plan, adapter, authorization)


def scan(manifest: DriveManifest) -> tuple[Finding, ...]:
    """Classify a bounded caller-supplied manifest without performing Drive I/O.

    Findings contain identifiers and short digests only. Document content is never copied into
    the result, an exception, or a receipt.
    """
    if len(manifest.documents) > MAX_MANIFEST_DOCUMENTS:
        raise ManifestShapeError(f"manifest exceeds the {MAX_MANIFEST_DOCUMENTS}-document limit")
    ids = [doc.file_id for doc in manifest.documents]
    duplicates = sorted(file_id for file_id, count in Counter(ids).items() if count > 1)
    if duplicates:
        raise ManifestShapeError("a file ID appears more than once")

    findings: list[Finding] = []
    for doc in manifest.documents:
        _validate_document(doc)
        if doc.mime_type != GOOGLE_DOC_MIME:
            continue
        if manifest.archive_parent_ids.intersection(doc.parent_ids):
            continue
        lines = doc.content.splitlines()
        for line_number, line in enumerate(lines, start=1):
            match = _RECORD_ROW.match(line)
            if match:
                route = _RECORD_ROUTES[match.group("prefix").upper()]
                findings.append(
                    _finding(
                        doc,
                        route,
                        f"{route.rule_stem}_record_row",
                        line_number,
                        line,
                        source_locator=f"line:{line_number}",
                        record_key=match.group("record_key").upper(),
                    )
                )

            cells = _pipe_cells(line)
            if cells:
                cell_set = frozenset(cells)
                for required, route in _HEADER_ROUTES:
                    if required <= cell_set:
                        findings.append(
                            _finding(
                                doc,
                                route,
                                f"{route.rule_stem}_status_table",
                                line_number,
                                line,
                                source_locator=f"line:{line_number}",
                            )
                        )
                        break

            if _QUESTIONNAIRE.match(line):
                route = _RECORD_ROUTES["DEC"]
                findings.append(
                    _finding(
                        doc,
                        route,
                        "questionnaire_answer",
                        line_number,
                        line,
                        source_locator=f"line:{line_number}",
                        record_key=_questionnaire_key(lines, line_number - 1),
                    )
                )

        changelog_heading = next(
            (i for i, line in enumerate(lines) if _CHANGELOG_HEADING.match(line)), None
        )
        if changelog_heading is not None:
            dated = next(
                (
                    (i, line)
                    for i, line in enumerate(lines[changelog_heading + 1 :], changelog_heading + 2)
                    if _DATED_ENTRY.match(line)
                ),
                None,
            )
            if dated:
                route = _Route("changelog", WORKBOOK_OPERATIONS, "Execution & Change Log")
                findings.append(
                    _finding(
                        doc,
                        route,
                        "append_only_changelog",
                        dated[0],
                        dated[1],
                        source_locator=f"line:{dated[0]}",
                        record_key="changelog:" + _fingerprint(dated[1]),
                    )
                )

        for table_number, table in enumerate(doc.tables, start=1):
            for row_number, row in enumerate(table.rows, start=1):
                locator = f"table:{table_number}:row:{row_number}"
                normalized = tuple(" ".join(cell.split()) for cell in row)
                lowered = frozenset(cell.lower() for cell in normalized if cell)
                for required, route in _HEADER_ROUTES:
                    if required <= lowered:
                        findings.append(
                            _finding(
                                doc,
                                route,
                                f"{route.rule_stem}_status_table",
                                0,
                                "\x1f".join(normalized),
                                source_locator=locator,
                            )
                        )
                        break
                record = _table_record_key(normalized)
                if record is not None:
                    record_key, prefix = record
                    route = _RECORD_ROUTES[prefix]
                    findings.append(
                        _finding(
                            doc,
                            route,
                            f"{route.rule_stem}_record_row",
                            0,
                            "\x1f".join(normalized),
                            source_locator=locator,
                            record_key=record_key,
                        )
                    )

    unique = {
        (
            item.file_id,
            item.rule,
            item.source_locator,
            item.evidence_fingerprint,
        ): item
        for item in findings
    }
    return tuple(
        sorted(
            unique.values(),
            key=lambda item: (
                item.file_id,
                item.rule,
                item.source_locator,
                item.evidence_fingerprint,
            ),
        )
    )


def plan_repairs(findings: tuple[Finding, ...], archive_parent_id: str) -> RepairPlan:
    """Create deterministic expected-state upserts and one archive proposal per source file."""
    if not archive_parent_id.strip():
        raise ManifestShapeError("archive parent ID is required")
    actions = tuple(
        SheetUpsert(
            stable_key=_stable_key(item),
            workbook=item.workbook,
            sheet=item.sheet,
            source_file_id=item.file_id,
            expected_revision_id=item.revision_id,
            evidence_fingerprint=item.evidence_fingerprint,
            rule=item.rule,
            record_key=_require_record_key(item),
            source_locator=item.source_locator,
            rollback_mode="restore_previous_or_remove_inserted",
        )
        for item in sorted(
            (finding for finding in findings if finding.record_key is not None),
            key=lambda value: (
                value.file_id,
                value.rule,
                value.source_locator,
                value.evidence_fingerprint,
            ),
        )
    )
    action_keys = [action.stable_key for action in actions]
    if len(action_keys) != len(set(action_keys)):
        raise ManifestShapeError("findings contain a duplicate logical record")
    by_file: dict[str, Finding] = {}
    for item in findings:
        existing = by_file.setdefault(item.file_id, item)
        if (
            existing.revision_id != item.revision_id
            or existing.original_parent_ids != item.original_parent_ids
        ):
            raise ManifestShapeError("findings disagree about a source file's expected state")
    archives = tuple(
        ArchiveProposal(
            file_id=item.file_id,
            expected_revision_id=item.revision_id,
            original_parent_ids=item.original_parent_ids,
            archive_parent_id=archive_parent_id,
            rollback_mode="restore_original_parents",
        )
        for item in sorted(by_file.values(), key=lambda value: value.file_id)
    )
    digest = _repair_digest(actions, archives)
    return RepairPlan(actions=actions, archives=archives, digest=digest)


def resolve(
    plan: RepairPlan, adapter: RepairAdapter, authorization: RepairAuthorization
) -> ResolveReceipt:
    """Apply an authorized plan through a caller-owned port and verify every readback.

    There is deliberately no delete operation in ``RepairAdapter``. Archive moves are optional,
    explicitly authorized, expected-state guarded, and preserve the source file ID/revision.
    """
    if plan.digest != _repair_digest(plan.actions, plan.archives):
        raise RepairRefused("repair plan was tampered with after its digest was issued")
    if authorization.plan_digest != plan.digest or not authorization.approved_by.strip():
        raise RepairRefused("authorization does not match the repair plan")

    expected_by_file: dict[str, tuple[str, tuple[str, ...], str | None]] = {}
    for action in plan.actions:
        current = expected_by_file.get(action.source_file_id)
        value = (action.expected_revision_id, (), None)
        if current is not None and current[0] != value[0]:
            raise RepairRefused("plan contains conflicting expected revisions")
        expected_by_file[action.source_file_id] = current or value
    for proposal in plan.archives:
        current = expected_by_file.get(proposal.file_id)
        if current is not None and current[0] != proposal.expected_revision_id:
            raise RepairRefused("plan contains conflicting expected revisions")
        expected_by_file[proposal.file_id] = (
            proposal.expected_revision_id,
            proposal.original_parent_ids,
            proposal.archive_parent_id,
        )

    states: dict[str, DocumentState] = {}
    for file_id, (revision_id, original_parents, archive_parent) in sorted(
        expected_by_file.items()
    ):
        state = adapter.document_state(file_id)
        if state.file_id != file_id or state.revision_id != revision_id:
            raise RepairRefused(f"source {file_id} revision no longer matches expected state")
        if original_parents and not (
            state.parent_ids == original_parents
            or (archive_parent is not None and state.parent_ids == (archive_parent,))
        ):
            raise RepairRefused(f"source {file_id} parents no longer match expected state")
        states[file_id] = state

    source_records: dict[str, SourceRecord] = {}
    previous_records: dict[str, SheetRecord | None] = {}
    for action in plan.actions:
        source = adapter.read_source(action)
        if (
            source.record_key != action.record_key
            or source.source_locator != action.source_locator
            or source.evidence_fingerprint != action.evidence_fingerprint
        ):
            raise RepairRefused("source record no longer matches the planned locator")
        source_records[action.stable_key] = source
        previous_records[action.stable_key] = adapter.read_record(
            action.workbook, action.sheet, action.stable_key
        )

    verified = 0
    sheet_rollbacks: list[SheetRollback] = []
    archived: list[str] = []
    parent_rollbacks: list[ParentRollback] = []
    try:
        for action in plan.actions:
            source = source_records[action.stable_key]
            previous = previous_records[action.stable_key]
            write_receipt = adapter.upsert(action, source)
            if (
                write_receipt.stable_key != action.stable_key
                or write_receipt.evidence_fingerprint != action.evidence_fingerprint
            ):
                raise RepairRefused("sheet write receipt does not match the planned record")
            readback = adapter.read_record(action.workbook, action.sheet, action.stable_key)
            if readback is None or (
                readback.stable_key != action.stable_key
                or readback.evidence_fingerprint != action.evidence_fingerprint
            ):
                raise RepairRefused("sheet readback does not match the planned record")
            if write_receipt.changed:
                sheet_rollbacks.append(
                    SheetRollback(
                        action=action,
                        written_fingerprint=action.evidence_fingerprint,
                        previous=previous,
                    )
                )
            verified += 1

        if authorization.allow_archive:
            for proposal in plan.archives:
                state = states[proposal.file_id]
                if state.parent_ids == (proposal.archive_parent_id,):
                    archived.append(proposal.file_id)
                    continue
                archive_receipt = adapter.archive(proposal)
                if (
                    archive_receipt.file_id != proposal.file_id
                    or archive_receipt.preserved_revision_id != proposal.expected_revision_id
                    or archive_receipt.previous_parent_ids != proposal.original_parent_ids
                    or archive_receipt.current_parent_ids != (proposal.archive_parent_id,)
                ):
                    raise RepairRefused("archive readback did not preserve the source file")
                final_state = adapter.document_state(proposal.file_id)
                if (
                    final_state.file_id != proposal.file_id
                    or final_state.revision_id != proposal.expected_revision_id
                    or final_state.parent_ids != (proposal.archive_parent_id,)
                ):
                    raise RepairRefused("archive state does not match its receipt")
                archived.append(proposal.file_id)
                parent_rollbacks.append(ParentRollback(proposal=proposal))
    except Exception as exc:
        partial = _discover_partial_rollback(
            plan,
            adapter,
            previous_records,
            sheet_rollbacks,
            parent_rollbacks,
        )
        try:
            rollback(
                partial,
                adapter,
                RollbackAuthorization(partial.digest, "system:auto-compensation"),
            )
        except RollbackPartialFailure as compensation_error:
            raise RepairPartialFailure(
                "repair failed and automatic compensation was incomplete",
                compensation_error.rollback_plan,
            ) from compensation_error
        except Exception as compensation_error:
            raise RepairPartialFailure(
                "repair failed and automatic compensation was incomplete",
                partial,
            ) from compensation_error
        raise RepairRefused("repair failed; completed mutations were rolled back") from exc

    rollback_plan = _make_rollback_plan(sheet_rollbacks, parent_rollbacks)

    return ResolveReceipt(
        plan_digest=plan.digest,
        verified_sheet_records=verified,
        archived_file_ids=tuple(archived),
        rollback=rollback_plan,
    )


def rollback(
    plan: RollbackPlan,
    adapter: RepairAdapter,
    authorization: RollbackAuthorization,
) -> RollbackReceipt:
    """Restore pre-write Sheet records and original Drive parents with guarded readback."""
    if plan.digest != _rollback_digest(plan.sheets, plan.parents):
        raise RepairRefused("rollback plan was tampered with after its digest was issued")
    if authorization.plan_digest != plan.digest or not authorization.approved_by.strip():
        raise RepairRefused("authorization does not match the rollback plan")

    sheets_to_restore: list[SheetRollback] = []
    for sheet_rollback in plan.sheets:
        action = sheet_rollback.action
        current_record = adapter.read_record(action.workbook, action.sheet, action.stable_key)
        if current_record == sheet_rollback.previous:
            continue
        if (
            current_record is None
            or current_record.evidence_fingerprint != sheet_rollback.written_fingerprint
        ):
            raise RepairRefused("Sheet record no longer matches rollback expected state")
        sheets_to_restore.append(sheet_rollback)

    parents_to_restore: list[ParentRollback] = []
    for parent in plan.parents:
        archive_proposal = parent.proposal
        current_state = adapter.document_state(archive_proposal.file_id)
        if current_state.revision_id != archive_proposal.expected_revision_id:
            raise RepairRefused("archived source no longer matches rollback expected state")
        if current_state.parent_ids == archive_proposal.original_parent_ids:
            continue
        if current_state.parent_ids != (archive_proposal.archive_parent_id,):
            raise RepairRefused("archived source no longer matches rollback expected state")
        parents_to_restore.append(parent)

    restored_sheets = 0
    restored_files: list[str] = []
    try:
        for sheet_rollback in reversed(sheets_to_restore):
            action = sheet_rollback.action
            adapter.rollback_sheet(sheet_rollback)
            readback = adapter.read_record(action.workbook, action.sheet, action.stable_key)
            if readback != sheet_rollback.previous:
                raise RepairRefused("Sheet rollback readback does not match the prior record")
            restored_sheets += 1

        for parent in reversed(parents_to_restore):
            archive_proposal = parent.proposal
            receipt = adapter.restore_parents(archive_proposal)
            if (
                receipt.file_id != archive_proposal.file_id
                or receipt.preserved_revision_id != archive_proposal.expected_revision_id
                or receipt.previous_parent_ids != (archive_proposal.archive_parent_id,)
                or receipt.current_parent_ids != archive_proposal.original_parent_ids
            ):
                raise RepairRefused("parent rollback receipt does not match the prior state")
            final = adapter.document_state(archive_proposal.file_id)
            if (
                final.revision_id != archive_proposal.expected_revision_id
                or final.parent_ids != archive_proposal.original_parent_ids
            ):
                raise RepairRefused("parent rollback readback does not match the prior state")
            restored_files.append(archive_proposal.file_id)
    except Exception as exc:
        remaining = _remaining_rollback(plan, adapter)
        raise RollbackPartialFailure(
            "rollback stopped before all actions completed", remaining
        ) from exc

    return RollbackReceipt(
        plan_digest=plan.digest,
        restored_sheet_records=restored_sheets,
        restored_file_ids=tuple(restored_files),
    )


def _discover_partial_rollback(
    plan: RepairPlan,
    adapter: RepairAdapter,
    previous_records: dict[str, SheetRecord | None],
    sheet_rollbacks: list[SheetRollback],
    parent_rollbacks: list[ParentRollback],
) -> RollbackPlan:
    """Reconcile mutation outcomes after an exception without exposing source values."""
    sheet_keys = {item.action.stable_key for item in sheet_rollbacks}
    for action in plan.actions:
        if action.stable_key in sheet_keys:
            continue
        try:
            current = adapter.read_record(action.workbook, action.sheet, action.stable_key)
        except Exception:
            sheet_rollbacks.append(
                SheetRollback(
                    action=action,
                    written_fingerprint=action.evidence_fingerprint,
                    previous=previous_records[action.stable_key],
                )
            )
            continue
        previous = previous_records[action.stable_key]
        if current is not None and current.evidence_fingerprint == action.evidence_fingerprint:
            if current != previous:
                sheet_rollbacks.append(
                    SheetRollback(
                        action=action,
                        written_fingerprint=action.evidence_fingerprint,
                        previous=previous,
                    )
                )

    parent_ids = {item.proposal.file_id for item in parent_rollbacks}
    for proposal in plan.archives:
        if proposal.file_id in parent_ids:
            continue
        try:
            state = adapter.document_state(proposal.file_id)
        except Exception:
            parent_rollbacks.append(ParentRollback(proposal=proposal))
            continue
        if state.parent_ids == (proposal.archive_parent_id,):
            parent_rollbacks.append(ParentRollback(proposal=proposal))
        elif state.parent_ids != proposal.original_parent_ids:
            parent_rollbacks.append(ParentRollback(proposal=proposal))

    return _make_rollback_plan(sheet_rollbacks, parent_rollbacks)


def _remaining_rollback(plan: RollbackPlan, adapter: RepairAdapter) -> RollbackPlan:
    sheets: list[SheetRollback] = []
    for sheet_proposal in plan.sheets:
        action = sheet_proposal.action
        try:
            current = adapter.read_record(action.workbook, action.sheet, action.stable_key)
        except Exception:
            sheets.append(sheet_proposal)
            continue
        if current != sheet_proposal.previous:
            sheets.append(sheet_proposal)

    parents: list[ParentRollback] = []
    for parent in plan.parents:
        archive_proposal = parent.proposal
        try:
            state = adapter.document_state(archive_proposal.file_id)
        except Exception:
            parents.append(parent)
            continue
        if state.parent_ids != archive_proposal.original_parent_ids:
            parents.append(parent)
    return _make_rollback_plan(sheets, parents)


def _validate_document(doc: DriveDocument) -> None:
    if not doc.file_id.strip() or not doc.revision_id.strip():
        raise ManifestShapeError("file and revision IDs are required")
    if len(doc.content) > MAX_CONTENT_CHARS:
        raise ManifestShapeError(f"document {doc.file_id} exceeds the content limit")
    if len(doc.parent_ids) > 32:
        raise ManifestShapeError(f"document {doc.file_id} exceeds the parent limit")
    table_cells = sum(len(row) for table in doc.tables for row in table.rows)
    table_chars = sum(len(cell) for table in doc.tables for row in table.rows for cell in row)
    if table_cells > MAX_TABLE_CELLS or len(doc.content) + table_chars > MAX_CONTENT_CHARS:
        raise ManifestShapeError(f"document {doc.file_id} exceeds the table content limit")


def _pipe_cells(line: str) -> tuple[str, ...]:
    if "|" not in line:
        return ()
    cells = tuple(" ".join(cell.split()).lower() for cell in line.strip().strip("|").split("|"))
    return tuple(cell for cell in cells if cell)


def _fingerprint(line: str) -> str:
    return hashlib.sha256(line.encode()).hexdigest()[:16]


def _finding(
    doc: DriveDocument,
    route: _Route,
    rule: str,
    line_number: int,
    line: str,
    *,
    source_locator: str,
    record_key: str | None = None,
) -> Finding:
    return Finding(
        file_id=doc.file_id,
        revision_id=doc.revision_id,
        original_parent_ids=doc.parent_ids,
        rule=rule,
        workbook=route.workbook,
        sheet=route.sheet,
        line_number=line_number,
        source_locator=source_locator,
        record_key=record_key,
        evidence_fingerprint=_fingerprint(line),
    )


def _stable_key(item: Finding) -> str:
    record_key = _require_record_key(item)
    raw = "|".join((item.workbook, item.sheet, record_key))
    return "drive-drift:" + hashlib.sha256(raw.encode()).hexdigest()[:24]


def _require_record_key(item: Finding) -> str:
    if item.record_key is None:
        raise ManifestShapeError("a Sheet upsert requires a logical record key")
    return item.record_key


def _questionnaire_key(lines: list[str], answer_index: int) -> str:
    context = next(
        (line.strip() for line in reversed(lines[:answer_index]) if line.strip()),
        "questionnaire",
    )
    return "answer:" + _fingerprint(context)


def _table_record_key(cells: tuple[str, ...]) -> tuple[str, str] | None:
    for cell in cells:
        match = _RECORD_KEY.fullmatch(cell)
        if match:
            return cell.upper(), match.group("prefix").upper()
    return None


def _repair_digest(actions: tuple[SheetUpsert, ...], archives: tuple[ArchiveProposal, ...]) -> str:
    payload = {
        "actions": [asdict(action) for action in actions],
        "archives": [asdict(proposal) for proposal in archives],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


def _make_rollback_plan(sheets: list[SheetRollback], parents: list[ParentRollback]) -> RollbackPlan:
    sheet_tuple = tuple(sheets)
    parent_tuple = tuple(parents)
    return RollbackPlan(
        sheets=sheet_tuple,
        parents=parent_tuple,
        digest=_rollback_digest(sheet_tuple, parent_tuple),
    )


def _rollback_digest(sheets: tuple[SheetRollback, ...], parents: tuple[ParentRollback, ...]) -> str:
    payload = {
        "sheets": [asdict(proposal) for proposal in sheets],
        "parents": [asdict(proposal) for proposal in parents],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(canonical).hexdigest()
