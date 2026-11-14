"""Operations Registry records in Needs Me and the briefing (#630).

Rows are shaped exactly as the Google Sheet holds them (title rows, then a header row, then data).
Every test uses its own row IDs and closes what it opened, because the session database is shared
with the other briefing tests.
"""

from collections.abc import Iterator
from datetime import date
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from api.main import app
from domains.ops import registry
from domains.ops.briefing import assemble, run_briefing
from domains.ops.types import define_ops_types
from kernel.access import AccessContext
from kernel.services import find
from scripts.migrate_briefing_composition import migrate

DAY = date(2032, 6, 8)  # a Tuesday, far from every other fixture
MB_HEADER = [
    "Blocker ID",
    "Status",
    "Work item",
    "System",
    "Minimum human action",
    "Owner",
    "Source",
]
TASK_HEADER = [
    "Task ID",
    "Title",
    "Domain",
    "Status",
    "Owner",
    "Next action",
    "Deadline",
    "Evidence / source",
]
ACTOR = "tests.ops.test_registry"


def uid(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:8]}"


@pytest.fixture
def opened(ctx: AccessContext) -> Iterator[list[registry.RegistryRecord]]:
    """Records a test opened; closed again afterwards so no other test sees them."""
    records: list[registry.RegistryRecord] = []
    yield records
    closed = [
        registry.RegistryRecord(**{**r.__dict__, "state": registry.STATE_CLOSED, "flags": ()})
        for r in records
    ]
    registry.capture(ctx, closed, actor=ACTOR)


def test_manual_blockers_are_shaped_by_header_and_status_token() -> None:
    a, b, c, d = uid("MB"), uid("MB"), uid("MB"), uid("MB")
    rows = [
        ["MANUAL BLOCKERS — HUMAN STEPS"],
        ["A blocker is manual only when ..."],
        MB_HEADER,
        [a, "RESOLVED 2026-11-13: done by run 1", "Ops token", "GitHub", "Renew", "Kyle", ""],
        [b, "RESOLVED→MB-002", "Old", "GitHub", "", "Kyle", ""],
        [
            c,
            "OPEN (owner, ~2 min).",
            "Signing key",
            "Infisical",
            "Grant once",
            "Kyle",
            "https://x/y",
        ],
        [d, "WATCH", "Google scope", "Google", "Approve", "Kyle", ""],
        [],
        ["", "section spacer"],
    ]
    shaped = {
        r.external_id: r for r in registry.manual_blockers(registry.from_tab(rows, "Blocker ID"))
    }
    assert [shaped[x].state for x in (a, b, c, d)] == ["closed", "closed", "open", "watch"]
    assert shaped[c].record_key == f"manual_blocker:{c}" and shaped[c].source_url == "https://x/y"
    assert shaped[c].next_action == "Grant once" and shaped[c].flags == ()
    assert shaped[b].flags == (registry.FLAG_NO_NEXT_ACTION,)
    assert len(shaped) == 4  # spacer rows have no identity and are skipped


def test_task_statuses_unknown_fails_visible_and_deadlines_need_a_source() -> None:
    ids = [uid("T") for _ in range(5)]
    rows = [
        TASK_HEADER,
        [
            ids[0],
            "Renew domain",
            "Admin",
            "READY",
            "Kyle",
            "Open registrar",
            "2032-06-20",
            "Gmail notice",
        ],
        [ids[1], "Old item", "Admin", "DONE", "Kyle", "", "", ""],
        [ids[2], "Someday", "Admin", "LATER", "Kyle", "", "", ""],
        [ids[3], "Odd status", "Admin", "MAYBE", "Kyle", "Look", "", ""],
        [ids[4], "Dated, no source", "Admin", "READY", "Kyle", "Call", "2032-06-21", ""],
    ]
    shaped = {r.external_id: r for r in registry.task_registry(rows)}
    assert (
        shaped[ids[0]].deadline == "2032-06-20" and shaped[ids[0]].deadline_source == "Gmail notice"
    )
    assert [shaped[i].state for i in ids[1:4]] == ["closed", "later", "unknown"]
    assert registry.FLAG_STATUS_UNKNOWN in shaped[ids[3]].flags
    assert shaped[ids[4]].deadline is None  # never presented as a fact without its source
    assert registry.FLAG_DEADLINE_UNSOURCED in shaped[ids[4]].flags


@pytest.mark.parametrize(
    "rows, message",
    [
        ([["Task ID", "Title", "Status", "Owner", "Next action", "Deadline"]], "evidence"),
        ([TASK_HEADER + ["Status"]], "more than once"),
        (
            [
                TASK_HEADER,
                ["P-9", "a", "x", "READY", "Kyle", "", "", ""],
                ["P-9", "b", "x", "READY", "Kyle", "", "", ""],
            ],
            "more than once",
        ),
        (
            [TASK_HEADER, ["bad id!", "a", "x", "READY", "Kyle", "", "", ""]],
            "not a valid identifier",
        ),
    ],
)
def test_bad_tabs_are_refused_whole(rows: list[list[str]], message: str) -> None:
    with pytest.raises(registry.RegistryShapeError, match=message):
        registry.task_registry(rows)


def test_capture_is_idempotent_and_needs_me_filters_and_orders(
    ctx: AccessContext, opened: list[registry.RegistryRecord]
) -> None:
    define_ops_types(ctx)
    blocker, dated, plain, other = uid("MB"), uid("T"), uid("T"), uid("T")
    records = registry.manual_blockers(
        [MB_HEADER, [blocker, "OPEN", "Grant", "Infisical", "Grant once", "Kyle", ""]]
    ) + registry.task_registry(
        [
            TASK_HEADER,
            [dated, "Dated", "Admin", "WAITING", "Kyle", "Call", "2032-06-09", "Letter"],
            [plain, "Plain", "Admin", "READY", "Kyle", "Open", "", ""],
            [other, "Engineering's", "Eng", "READY", "Engineering", "Fix", "", ""],
        ]
    )
    opened.extend(records)
    first = registry.capture(ctx, records, actor=ACTOR)
    again = registry.capture(ctx, records, actor=ACTOR)
    assert (first.captured, again.captured, again.unchanged) == (4, 0, 4)

    mine = {blocker, dated, plain}
    listed = [
        e.attributes["external_id"]
        for e in registry.needs_me(find(ctx, type_name=registry.TYPE_NAME))
        if e.attributes["external_id"] in mine | {other}
    ]
    assert listed == [
        dated,
        blocker,
        plain,
    ]  # dated first, then blockers, then tasks; others' rows hidden


def test_briefing_cites_registry_records_by_id_with_event_provenance_and_is_idempotent(
    ctx: AccessContext, opened: list[registry.RegistryRecord]
) -> None:
    define_ops_types(ctx)
    migrate()  # the briefing schema gains needs_me_registry_ids
    blocker = uid("MB")
    records = registry.manual_blockers(
        [MB_HEADER, [blocker, "BLOCKED", "Pixel", "Phone", "Ack", "Kyle", ""]]
    )
    opened.extend(records)
    registry.capture(ctx, records, actor=ACTOR)
    (entity,) = find(
        ctx, type_name=registry.TYPE_NAME, filters={"record_key": f"manual_blocker:{blocker}"}
    )

    attributes = assemble(ctx, DAY, ZoneInfo("UTC"))
    assert str(entity.id) in attributes["needs_me_registry_ids"]
    assert str(entity.id) in attributes["provenance"]["source_entity_ids"]
    assert all("Pixel" not in str(v) for v in attributes.values())  # ids only, no copied text
    first = run_briefing(ctx, DAY)
    assert (
        run_briefing(ctx, DAY).unchanged and run_briefing(ctx, DAY).briefing_id == first.briefing_id
    )


def test_api_lists_registry_needs_me_and_consent_receipt_needs_a_real_request(
    ctx: AccessContext, opened: list[registry.RegistryRecord], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LIFEOS_AUTH_MODE", "disabled")  # route passthrough, as tests/api does
    define_ops_types(ctx)
    task = uid("T")
    records = registry.task_registry(
        [TASK_HEADER, [task, "Call the bank", "Finance", "READY", "Kyle", "Call", "", ""]]
    )
    opened.extend(records)
    registry.capture(ctx, records, actor=ACTOR)
    client = TestClient(app)
    body = client.get("/needs-me/registry").json()
    item = next(i for i in body if i["external_id"] == task)
    assert item["source_kind"] == "task" and item["source_key"] == f"task:{task}"
    assert item["next_action"] == "Call" and item["deadline"] is None

    subject = f"agent:never-{uuid4().hex[:6]}"
    assert client.get(f"/agents/consent/{subject}").status_code == 404


def test_first_persisted_request_is_the_consent_receipt_and_only_requests_count() -> None:
    from domains.agents.requests import first_request_by, request
    from domains.agents.roles import Role, default_registry

    subject = f"agent:consent-{uuid4().hex[:6]}"
    read = AccessContext.of("agents:read")
    assert first_request_by(read, subject) is None  # minted or configured is not consent
    asker = AccessContext.of("agents:request")
    first = request(
        asker,
        default_registry(),
        Role("communications"),
        "create_drafts",
        f"k1-{uuid4()}",
        requested_by=subject,
        allowed_roles=["communications"],
    )
    request(
        asker,
        default_registry(),
        Role("communications"),
        "create_drafts",
        f"k2-{uuid4()}",
        requested_by=subject,
        allowed_roles=["communications"],
    )
    receipt = first_request_by(read, subject)
    assert receipt is not None and receipt.receipt_key == first.receipt.receipt_key
    assert receipt.requested_by == subject


def test_import_script_refuses_a_bad_tab_whole_and_reruns_write_nothing(
    opened: list[registry.RegistryRecord],
) -> None:
    from scripts.import_registry import run

    good = uid("T")
    snapshot = {
        "task_registry": [
            ["LIFEOS TASK REGISTRY"],
            [],
            TASK_HEADER,
            [good, "Imported", "Admin", "READY", "Kyle", "Do it", "", ""],
        ]
    }
    opened.extend(registry.task_registry(registry.from_tab(snapshot["task_registry"], "Task ID")))
    assert run(snapshot) == {"records": 1, "captured": 1, "unchanged": 0}
    assert run(snapshot) == {"records": 1, "captured": 0, "unchanged": 1}
    with pytest.raises(registry.RegistryShapeError):
        run({"manual_blockers": [["no header here"]]})


def test_a_shifted_row_is_refused_not_misfiled() -> None:
    # 2026-11-14: rows missing the "Immediate workaround" cell put the last-verified date
    # under Owner, so the blocker silently dropped out of Needs Me.
    shifted = [MB_HEADER, ["MB-900", "OPEN", "Item", "Sys", "Act", "2026-11-13", "https://x"]]
    with pytest.raises(registry.RegistryShapeError, match="columns look shifted"):
        registry.manual_blockers(shifted)
