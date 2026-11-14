"""Docs-as-guides / Sheets-as-records enforcement (P-60, #636)."""

from __future__ import annotations

import json
from dataclasses import asdict, replace
from io import StringIO
from pathlib import Path

import pytest

from domains.ops.drive_policy import (
    GOOGLE_DOC_MIME,
    ArchiveReceipt,
    ConnectorRepairAdapter,
    DocumentState,
    DriveDocument,
    DriveManifest,
    DriveTable,
    ManifestShapeError,
    RepairAuthorization,
    RepairPlan,
    RepairRefused,
    RollbackAuthorization,
    RollbackPartialFailure,
    SheetRecord,
    SheetWriteReceipt,
    SourceRecord,
    apply_registered,
    plan_repairs,
    prepare_registered,
    resolve,
    rollback_registered,
    scan,
)
from scripts.scan_drive_policy import load_payload, run


def document(
    content: str,
    *,
    file_id: str = "doc-active-1",
    revision_id: str = "rev-1",
    parent_ids: tuple[str, ...] = ("lifeos-root",),
) -> DriveDocument:
    return DriveDocument(
        file_id=file_id,
        revision_id=revision_id,
        mime_type=GOOGLE_DOC_MIME,
        parent_ids=parent_ids,
        content=content,
    )


def test_scan_detects_record_rows_and_emits_fingerprints_not_content() -> None:
    manifest = DriveManifest(
        documents=(
            document(
                "# Daily guide\n"
                "| Task ID | Title | Status | Owner |\n"
                "| P-61 | rotate token super-secret-value | READY | Kyle |\n"
                "Answer: owner-only\n"
            ),
        ),
        archive_parent_ids=frozenset({"archive"}),
    )

    findings = scan(manifest)

    assert [(f.rule, f.workbook, f.sheet) for f in findings] == [
        ("questionnaire_answer", "owner_decisions", "Decisions"),
        ("task_record_row", "operations_registry", "Task Registry"),
        ("task_status_table", "operations_registry", "Task Registry"),
    ]
    serialized = str([asdict(f) for f in findings])
    assert "super-secret-value" not in serialized
    assert all(len(f.evidence_fingerprint) == 16 for f in findings)


def test_scan_ignores_guidance_prose_archives_and_non_google_docs() -> None:
    guidance = document(
        "# Execution Guide\nTasks and changelogs belong in the Operations Registry Sheet.\n",
        file_id="guide",
    )
    archived = document(
        "| Task ID | Status |\n| P-1 | DONE |\n",
        file_id="old",
        parent_ids=("archive",),
    )
    markdown = DriveDocument(
        file_id="markdown",
        revision_id="rev-1",
        mime_type="text/markdown",
        parent_ids=("lifeos-root",),
        content="| Task ID | Status |\n| P-2 | READY |",
    )

    assert (
        scan(
            DriveManifest(
                documents=(guidance, archived, markdown),
                archive_parent_ids=frozenset({"archive"}),
            )
        )
        == ()
    )


def test_manifest_is_bounded_and_duplicate_file_ids_are_refused() -> None:
    duplicate = document("one")
    with pytest.raises(ManifestShapeError, match="more than once"):
        scan(
            DriveManifest(
                documents=(duplicate, duplicate), archive_parent_ids=frozenset({"archive"})
            )
        )
    with pytest.raises(ManifestShapeError, match="content limit"):
        scan(
            DriveManifest(
                documents=(document("x" * 250_001),),
                archive_parent_ids=frozenset({"archive"}),
            )
        )


def test_change_log_requires_a_heading_and_dated_entry() -> None:
    manifest = DriveManifest(
        documents=(
            document(
                "# Runbook\n## Change Log\n2026-11-14 | Codex | migrated records\n",
                file_id="log-doc",
            ),
            document("The words change log and 2026-11-14 can appear in prose.", file_id="prose"),
        ),
        archive_parent_ids=frozenset({"archive"}),
    )

    findings = scan(manifest)

    assert [(f.file_id, f.rule, f.sheet) for f in findings] == [
        ("log-doc", "append_only_changelog", "Execution & Change Log")
    ]


def test_scan_detects_native_google_docs_tables_without_pipe_delimited_text() -> None:
    source = replace(
        document("# Guide\n"),
        tables=(
            DriveTable(
                rows=(
                    ("Task ID", "Title", "Status"),
                    ("P-61", "Move this record", "READY"),
                )
            ),
        ),
    )

    findings = scan(DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"})))

    assert [(item.rule, item.record_key, item.source_locator) for item in findings] == [
        ("task_record_row", "P-61", "table:1:row:2"),
        ("task_status_table", None, "table:1:row:1"),
    ]


class FakeAdapter:
    def __init__(self, state: DocumentState) -> None:
        self.state = state
        self.rows: dict[tuple[str, str, str], SheetRecord] = {}
        self.upsert_calls = 0
        self.archive_calls = 0

    def document_state(self, file_id: str) -> DocumentState:
        assert file_id == self.state.file_id
        return self.state

    def read_source(self, action: object) -> SourceRecord:
        from domains.ops.drive_policy import SheetUpsert

        assert isinstance(action, SheetUpsert)
        return SourceRecord(
            record_key=action.record_key,
            source_locator=action.source_locator,
            evidence_fingerprint=action.evidence_fingerprint,
            field_names=("record_key",),
            field_values=(action.record_key,),
        )

    def upsert(self, action: object, source: SourceRecord) -> SheetWriteReceipt:
        from domains.ops.drive_policy import SheetUpsert

        assert isinstance(action, SheetUpsert)
        assert source.record_key == action.record_key
        key = (action.workbook, action.sheet, action.stable_key)
        current = self.rows.get(key)
        if current is None or current.evidence_fingerprint != action.evidence_fingerprint:
            self.upsert_calls += 1
            current = SheetRecord(
                stable_key=action.stable_key,
                evidence_fingerprint=action.evidence_fingerprint,
                field_names=source.field_names,
                field_values=source.field_values,
            )
            self.rows[key] = current
            changed = True
        else:
            changed = False
        return SheetWriteReceipt(
            stable_key=action.stable_key,
            evidence_fingerprint=current.evidence_fingerprint,
            changed=changed,
        )

    def read_record(self, workbook: str, sheet: str, stable_key: str) -> SheetRecord | None:
        return self.rows.get((workbook, sheet, stable_key))

    def archive(self, proposal: object) -> ArchiveReceipt:
        from domains.ops.drive_policy import ArchiveProposal

        assert isinstance(proposal, ArchiveProposal)
        self.archive_calls += 1
        self.state = DocumentState(
            file_id=self.state.file_id,
            revision_id=self.state.revision_id,
            parent_ids=(proposal.archive_parent_id,),
        )
        return ArchiveReceipt(
            file_id=self.state.file_id,
            preserved_revision_id=self.state.revision_id,
            previous_parent_ids=proposal.original_parent_ids,
            current_parent_ids=self.state.parent_ids,
        )

    def rollback_sheet(self, proposal: object) -> SheetRecord | None:
        from domains.ops.drive_policy import SheetRollback

        assert isinstance(proposal, SheetRollback)
        action = proposal.action
        key = (action.workbook, action.sheet, action.stable_key)
        if proposal.previous is None:
            self.rows.pop(key, None)
        else:
            self.rows[key] = proposal.previous
        return proposal.previous

    def restore_parents(self, proposal: object) -> ArchiveReceipt:
        from domains.ops.drive_policy import ArchiveProposal

        assert isinstance(proposal, ArchiveProposal)
        previous = self.state.parent_ids
        self.state = replace(self.state, parent_ids=proposal.original_parent_ids)
        return ArchiveReceipt(
            file_id=self.state.file_id,
            preserved_revision_id=self.state.revision_id,
            previous_parent_ids=previous,
            current_parent_ids=self.state.parent_ids,
        )


def test_repair_plan_and_resolver_are_idempotent_expected_state_guarded_and_re_scan_clean() -> None:
    source = document("| Entity ID | Display name | Status |\n| ENT-7 | Example | ACTIVE |")
    manifest = DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"}))
    findings = scan(manifest)
    first = plan_repairs(findings, archive_parent_id="archive")
    second = plan_repairs(findings, archive_parent_id="archive")
    assert first == second
    assert first.actions[0].rollback_mode == "restore_previous_or_remove_inserted"
    assert first.archives[0].rollback_mode == "restore_original_parents"

    adapter = FakeAdapter(
        DocumentState(
            file_id=source.file_id, revision_id=source.revision_id, parent_ids=source.parent_ids
        )
    )
    authorization = RepairAuthorization(
        plan_digest=first.digest, approved_by="owner-standin", allow_archive=True
    )
    receipt = resolve(first, adapter, authorization)
    repeated = resolve(first, adapter, authorization)

    assert receipt.verified_sheet_records == len(first.actions)
    assert receipt.archived_file_ids == (source.file_id,)
    assert adapter.upsert_calls == len(first.actions)  # second run is an unchanged upsert
    assert adapter.archive_calls == 1  # already archived on the second run
    repaired = DriveManifest(
        documents=(
            DriveDocument(
                file_id=source.file_id,
                revision_id=source.revision_id,
                mime_type=source.mime_type,
                parent_ids=("archive",),
                content=source.content,
            ),
        ),
        archive_parent_ids=frozenset({"archive"}),
    )
    assert scan(repaired) == ()
    assert repeated.verified_sheet_records == len(first.actions)


def test_registered_connector_adapter_executes_the_same_verified_resolver_contract() -> None:
    source = document("| P-70 | Connector path | READY |")
    plan = plan_repairs(
        scan(DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"}))),
        archive_parent_id="archive",
    )
    binding = FakeAdapter(DocumentState(source.file_id, source.revision_id, source.parent_ids))
    adapter = ConnectorRepairAdapter(
        state_reader=binding.document_state,
        source_reader=binding.read_source,
        sheet_upserter=binding.upsert,
        sheet_reader=binding.read_record,
        archiver=binding.archive,
        sheet_rollback=binding.rollback_sheet,
        parent_restorer=binding.restore_parents,
    )

    receipt = resolve(
        plan,
        adapter,
        RepairAuthorization(plan.digest, "owner-standin", allow_archive=True),
    )

    assert receipt.verified_sheet_records == 1
    assert receipt.archived_file_ids == (source.file_id,)


def test_r2_operation_is_registered_with_check_resolver_rollback_and_verification() -> None:
    registry_path = Path(__file__).resolve().parents[2] / "ops-repair-operations.json"
    registry = json.loads(registry_path.read_text())
    (operation,) = registry["operations"]

    assert operation["id"] == "lifeos.drive.docs-sheets-drift.v1"
    assert operation["risk"] == "R2"
    assert operation["check"] == "domains.ops.drive_policy:prepare_registered"
    assert operation["resolver"] == "domains.ops.drive_policy:apply_registered"
    assert "rollback" in operation and "verification" in operation


def test_registered_dispatch_restores_an_updated_row_and_original_drive_parents() -> None:
    operation_id = "lifeos.drive.docs-sheets-drift.v1"
    source = document("| P-71 | Updated value | READY |")
    manifest = DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"}))
    plan = prepare_registered(operation_id, manifest, "archive")
    action = plan.actions[0]
    prior = SheetRecord(
        stable_key=action.stable_key,
        evidence_fingerprint="prior-fingerprint",
        field_names=("Task ID", "Title", "Status"),
        field_values=("P-71", "Prior value", "READY"),
    )
    adapter = FakeAdapter(DocumentState(source.file_id, source.revision_id, source.parent_ids))
    adapter.rows[(action.workbook, action.sheet, action.stable_key)] = prior

    applied = apply_registered(
        operation_id,
        plan,
        adapter,
        RepairAuthorization(plan.digest, "owner-standin", allow_archive=True),
    )
    rolled_back = rollback_registered(
        operation_id,
        applied.rollback,
        adapter,
        RollbackAuthorization(applied.rollback.digest, "owner-standin"),
    )

    assert adapter.read_record(action.workbook, action.sheet, action.stable_key) == prior
    assert adapter.state.parent_ids == source.parent_ids
    assert rolled_back.restored_sheet_records == 1
    assert rolled_back.restored_file_ids == (source.file_id,)


def test_apply_failure_after_first_sheet_write_automatically_compensates() -> None:
    class FailSecondWrite(FakeAdapter):
        def __init__(self, state: DocumentState) -> None:
            super().__init__(state)
            self.attempts = 0

        def upsert(self, action: object, source: SourceRecord) -> SheetWriteReceipt:
            self.attempts += 1
            if self.attempts == 2:
                raise ConnectionError("injected connector failure")
            return super().upsert(action, source)

    operation_id = "lifeos.drive.docs-sheets-drift.v1"
    source = document("| P-80 | First | READY |\n| ENT-80 | Second | ACTIVE |")
    plan = prepare_registered(
        operation_id,
        DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"})),
        "archive",
    )
    adapter = FailSecondWrite(DocumentState(source.file_id, source.revision_id, source.parent_ids))

    with pytest.raises(RepairRefused, match="rolled back"):
        apply_registered(
            operation_id,
            plan,
            adapter,
            RepairAuthorization(plan.digest, "owner-standin", allow_archive=True),
        )

    assert adapter.rows == {}
    assert adapter.state.parent_ids == source.parent_ids
    assert adapter.archive_calls == 0


def test_archive_failure_after_sheet_write_automatically_compensates() -> None:
    class FailArchive(FakeAdapter):
        def archive(self, proposal: object) -> ArchiveReceipt:
            raise ConnectionError("injected archive failure")

    operation_id = "lifeos.drive.docs-sheets-drift.v1"
    source = document("| P-81 | First | READY |")
    plan = prepare_registered(
        operation_id,
        DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"})),
        "archive",
    )
    adapter = FailArchive(DocumentState(source.file_id, source.revision_id, source.parent_ids))

    with pytest.raises(RepairRefused, match="rolled back"):
        apply_registered(
            operation_id,
            plan,
            adapter,
            RepairAuthorization(plan.digest, "owner-standin", allow_archive=True),
        )

    assert adapter.rows == {}
    assert adapter.state.parent_ids == source.parent_ids


def test_ambiguous_upsert_and_archive_outcomes_are_reconciled_and_compensated() -> None:
    class MutateThenFail(FakeAdapter):
        def __init__(self, state: DocumentState, failure: str) -> None:
            super().__init__(state)
            self.failure = failure
            self.failed = False

        def upsert(self, action: object, source: SourceRecord) -> SheetWriteReceipt:
            receipt = super().upsert(action, source)
            if self.failure == "upsert" and not self.failed:
                self.failed = True
                raise ConnectionError("response lost after Sheet mutation")
            return receipt

        def archive(self, proposal: object) -> ArchiveReceipt:
            receipt = super().archive(proposal)
            if self.failure == "archive" and not self.failed:
                self.failed = True
                raise ConnectionError("response lost after archive mutation")
            return receipt

    operation_id = "lifeos.drive.docs-sheets-drift.v1"
    for failure in ("upsert", "archive"):
        source = document("| P-82 | Ambiguous | READY |", file_id=f"doc-{failure}")
        plan = prepare_registered(
            operation_id,
            DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"})),
            "archive",
        )
        adapter = MutateThenFail(
            DocumentState(source.file_id, source.revision_id, source.parent_ids), failure
        )

        with pytest.raises(RepairRefused, match="rolled back"):
            apply_registered(
                operation_id,
                plan,
                adapter,
                RepairAuthorization(plan.digest, "owner-standin", allow_archive=True),
            )

        assert adapter.rows == {}
        assert adapter.state.parent_ids == source.parent_ids


def test_rollback_retry_plan_excludes_a_restore_that_succeeded_before_response_loss() -> None:
    class RestoreThenFail(FakeAdapter):
        fail_rollback = False

        def rollback_sheet(self, proposal: object) -> SheetRecord | None:
            result = super().rollback_sheet(proposal)
            if self.fail_rollback:
                self.fail_rollback = False
                raise ConnectionError("response lost after Sheet restore")
            return result

    operation_id = "lifeos.drive.docs-sheets-drift.v1"
    source = document("| P-83 | Retry rollback | READY |")
    plan = prepare_registered(
        operation_id,
        DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"})),
        "archive",
    )
    adapter = RestoreThenFail(DocumentState(source.file_id, source.revision_id, source.parent_ids))
    applied = apply_registered(
        operation_id,
        plan,
        adapter,
        RepairAuthorization(plan.digest, "owner-standin", allow_archive=True),
    )
    adapter.fail_rollback = True

    with pytest.raises(RollbackPartialFailure) as failure:
        rollback_registered(
            operation_id,
            applied.rollback,
            adapter,
            RollbackAuthorization(applied.rollback.digest, "owner-standin"),
        )

    remaining = failure.value.rollback_plan
    assert remaining.sheets == ()
    assert len(remaining.parents) == 1
    rollback_registered(
        operation_id,
        remaining,
        adapter,
        RollbackAuthorization(remaining.digest, "owner-standin"),
    )
    assert adapter.rows == {}
    assert adapter.state.parent_ids == source.parent_ids


def test_resolver_refuses_stale_or_unauthorized_plan_before_writing() -> None:
    source = document("| Decision ID | Question | Status |\n| DEC-7 | Choose | DECIDED |")
    plan = plan_repairs(
        scan(DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"}))),
        archive_parent_id="archive",
    )
    stale = FakeAdapter(
        DocumentState(
            file_id=source.file_id, revision_id="new-revision", parent_ids=source.parent_ids
        )
    )
    with pytest.raises(RepairRefused, match="revision"):
        resolve(
            plan,
            stale,
            RepairAuthorization(plan_digest=plan.digest, approved_by="owner-standin"),
        )
    assert stale.upsert_calls == 0 and stale.archive_calls == 0

    current = FakeAdapter(
        DocumentState(
            file_id=source.file_id, revision_id=source.revision_id, parent_ids=source.parent_ids
        )
    )
    with pytest.raises(RepairRefused, match="authorization"):
        resolve(
            plan,
            current,
            RepairAuthorization(plan_digest="wrong", approved_by="owner-standin"),
        )
    assert current.upsert_calls == 0 and current.archive_calls == 0


def test_resolver_refuses_a_tampered_plan_digest_before_any_adapter_call() -> None:
    source = document("| P-7 | Original | READY |")
    plan = plan_repairs(
        scan(DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"}))),
        archive_parent_id="archive",
    )
    tampered = RepairPlan(
        actions=(replace(plan.actions[0], sheet="Different Sheet"),),
        archives=plan.archives,
        digest=plan.digest,
    )
    adapter = FakeAdapter(
        DocumentState(
            file_id=source.file_id,
            revision_id=source.revision_id,
            parent_ids=source.parent_ids,
        )
    )

    with pytest.raises(RepairRefused, match="tampered"):
        resolve(
            tampered,
            adapter,
            RepairAuthorization(plan_digest=plan.digest, approved_by="owner-standin"),
        )

    assert adapter.upsert_calls == 0 and adapter.archive_calls == 0


def test_resolver_refuses_changed_source_locator_before_sheet_write() -> None:
    class ChangedSourceAdapter(FakeAdapter):
        def read_source(self, action: object) -> SourceRecord:
            current = super().read_source(action)
            return replace(current, evidence_fingerprint="changed")

    source = document("| P-8 | Original | READY |")
    plan = plan_repairs(
        scan(DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"}))),
        archive_parent_id="archive",
    )
    adapter = ChangedSourceAdapter(
        DocumentState(source.file_id, source.revision_id, source.parent_ids)
    )

    with pytest.raises(RepairRefused, match="source record"):
        resolve(
            plan,
            adapter,
            RepairAuthorization(plan_digest=plan.digest, approved_by="owner-standin"),
        )

    assert adapter.upsert_calls == 0 and adapter.archive_calls == 0


def test_sheet_identity_survives_source_edits_and_line_moves_without_duplicate_rows() -> None:
    before = document("| P-88 | Do thing | READY |", revision_id="rev-1")
    after = document("intro\n\n| P-88 | Do thing | DONE |", revision_id="rev-2")

    before_plan = plan_repairs(
        scan(DriveManifest(documents=(before,), archive_parent_ids=frozenset())),
        archive_parent_id="archive",
    )
    after_plan = plan_repairs(
        scan(DriveManifest(documents=(after,), archive_parent_ids=frozenset())),
        archive_parent_id="archive",
    )

    assert before_plan.actions[0].record_key == "P-88"
    assert before_plan.actions[0].stable_key == after_plan.actions[0].stable_key
    assert before_plan.actions[0].source_locator != after_plan.actions[0].source_locator
    assert before_plan.actions[0].evidence_fingerprint != after_plan.actions[0].evidence_fingerprint


def test_repair_plan_refuses_the_same_canonical_record_across_two_docs() -> None:
    first = document("| P-88 | First | READY |", file_id="doc-a")
    second = document("| P-88 | Second | READY |", file_id="doc-b")
    findings = scan(DriveManifest(documents=(first, second), archive_parent_ids=frozenset()))

    with pytest.raises(ManifestShapeError, match="duplicate logical record"):
        plan_repairs(findings, archive_parent_id="archive")


def test_resolver_refuses_an_archive_that_keeps_the_original_parent() -> None:
    class IncompleteMoveAdapter(FakeAdapter):
        def archive(self, proposal: object) -> ArchiveReceipt:
            from domains.ops.drive_policy import ArchiveProposal

            assert isinstance(proposal, ArchiveProposal)
            self.archive_calls += 1
            current = self.state.parent_ids + (proposal.archive_parent_id,)
            self.state = replace(self.state, parent_ids=current)
            return ArchiveReceipt(
                file_id=self.state.file_id,
                preserved_revision_id=self.state.revision_id,
                previous_parent_ids=proposal.original_parent_ids,
                current_parent_ids=current,
            )

    source = document("| P-10 | Move me | READY |")
    plan = plan_repairs(
        scan(DriveManifest(documents=(source,), archive_parent_ids=frozenset({"archive"}))),
        archive_parent_id="archive",
    )
    adapter = IncompleteMoveAdapter(
        DocumentState(source.file_id, source.revision_id, source.parent_ids)
    )

    with pytest.raises(RepairRefused, match="repair failed"):
        resolve(
            plan,
            adapter,
            RepairAuthorization(
                plan_digest=plan.digest,
                approved_by="owner-standin",
                allow_archive=True,
            ),
        )


def test_cli_report_is_bounded_and_never_echoes_document_content() -> None:
    payload = {
        "archive_parent_ids": ["archive"],
        "documents": [
            {
                "file_id": "doc-1",
                "revision_id": "rev-1",
                "mime_type": GOOGLE_DOC_MIME,
                "parent_ids": ["lifeos-root"],
                "content": "| Task ID | Status | Notes |\n| P-9 | READY | do-not-print-this |",
                "tables": [],
            }
        ],
    }

    report = run(payload, archive_parent_id="archive")

    assert report["documents_scanned"] == 1
    assert report["findings"] == 2
    assert "do-not-print-this" not in str(report)
    assert report["plan_digest"].startswith("sha256:")


def test_cli_can_read_a_manifest_from_stdin_without_persisting_document_content() -> None:
    payload = load_payload(Path("-"), StringIO('{"documents": []}'))
    encoded = load_payload(
        Path("-"),
        StringIO("eyJkb2N1bWVudHMiOiBbXX0=\n\n"),
        base64_lines=True,
    )

    assert payload == {"documents": []}
    assert encoded == payload


@pytest.mark.parametrize(
    "tables",
    [
        ["not-an-object"],
        [{"rows": ["not-a-row"]}],
        [{"rows": [["ok"], 7]}],
    ],
)
def test_cli_refuses_malformed_native_table_shapes(tables: object) -> None:
    payload = {
        "documents": [
            {
                "file_id": "doc-1",
                "revision_id": "rev-1",
                "mime_type": GOOGLE_DOC_MIME,
                "parent_ids": [],
                "content": "",
                "tables": tables,
            }
        ]
    }

    with pytest.raises(ValueError, match="tables"):
        run(payload)
