"""Integration: `x-sensitive` withholding on the shared agent-tool surface
(ADR 016).

The flag's whole meaning is this test: a type marked `x-sensitive` — medical
bills, EOBs, and the uploaded documents they are extracted from — never reaches
a model through a generic read tool, whichever door asked and however its scopes
were granted. If this file is deleted, the flag is decoration.
"""

from typing import Any
from uuid import UUID

import pymupdf
import pytest

from domains.bills.types import (
    DOMAIN,
    STATUS_CANDIDATE,
    TYPE_BILL,
    TYPE_EXTRACTION,
    define_bills_types,
)
from domains.documents.capture import capture_document
from domains.documents.storage import BlobStore
from domains.episodes.types import DOMAIN as EPISODES_DOMAIN
from domains.episodes.types import TYPE_EPISODE, TYPE_PLAYBOOK, define_episode_types
from kernel.access import AccessContext, ScopeError, has
from kernel.services import capture, find
from mcp_server import tools

SENSITIVE_CTX = AccessContext.of(f"{DOMAIN}:read", f"{DOMAIN}:write", "relationships:read")


@pytest.fixture(scope="module")
def candidate(seeded: dict[str, UUID]) -> UUID:
    """One candidate bill, invented, so there is something to withhold."""
    define_bills_types(SENSITIVE_CTX)
    attributes: dict[str, Any] = {
        "bill_key": "c" * 64,
        "status": STATUS_CANDIDATE,
        "category": "medical",
        "issuer": "Mercy Clinic mcpsensitive",
        "total": 42.0,
        "extracted_at": "2026-07-29T00:00:00+00:00",
        "provenance": {
            "source_entity_ids": [],
            "source_event_ids": [],
            "method": "llm_extraction",
            "confidence": 0.5,
        },
    }
    return capture(SENSITIVE_CTX, TYPE_BILL, attributes).entity_id


def test_the_scopes_really_do_reach_the_candidate_without_the_tools(
    candidate: UUID,
) -> None:
    """Not a vacuous test: the same context reads the bill fine through the
    kernel services the API and the CLI use. Only the model-facing surface is
    narrowed."""
    assert candidate in {e.id for e in find(SENSITIVE_CTX, type_name=TYPE_BILL)}
    assert has(SENSITIVE_CTX, f"{DOMAIN}:read")


def test_agent_read_context_drops_the_sensitive_domain(candidate: UUID) -> None:
    narrowed = tools.agent_read_context(SENSITIVE_CTX)
    assert "relationships:read" in narrowed.scopes
    assert not any(scope.startswith(f"{DOMAIN}:") for scope in narrowed.scopes)
    # a narrowing, never a widening: no write scope survives either
    assert not any(scope.endswith(":write") for scope in narrowed.scopes)


def test_the_agent_tools_cannot_list_find_or_fetch_a_sensitive_record(
    candidate: UUID,
) -> None:
    listed = {t["name"] for t in tools.list_types(SENSITIVE_CTX)["types"]}
    assert TYPE_BILL not in listed
    # the whole domain goes, not just the flagged type: scopes are
    # domain-shaped (invariant 5), and that is the safe direction
    assert TYPE_EXTRACTION not in listed

    with pytest.raises(ScopeError):
        tools.find(SENSITIVE_CTX, type_name=TYPE_BILL)
    with pytest.raises(ScopeError):
        tools.get_entity(SENSITIVE_CTX, str(candidate))
    with pytest.raises(ScopeError):
        tools.history(SENSITIVE_CTX, str(candidate))


def test_an_untyped_or_text_search_cannot_reach_it_either(candidate: UUID) -> None:
    """The interesting case: a model that does not name the type still must not
    stumble onto a bill through a broad search."""
    found = {e["id"] for e in tools.find(SENSITIVE_CTX)["entities"]}
    assert str(candidate) not in found
    assert tools.find(SENSITIVE_CTX, text="mcpsensitive")["entities"] == []


def test_a_document_filename_is_unreachable_through_the_tools(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """The same PHI, one hop earlier. `original_filename` routinely reads
    `EOB_Jane_Doe_2026-03.pdf`, and it lives in the graph where the bytes and
    the text deliberately do not — so `document` is `x-sensitive` too. Without
    this the control would cover the extracted bill and miss the file it came
    from, with no extraction record and no operator action involved."""
    doc_ctx = AccessContext.of("documents:read", "documents:write")
    store = BlobStore(tmp_path_factory.mktemp("sensitive-blobs"))
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((72, 72), "statement")
        data = bytes(pdf.tobytes())
    capture_document(doc_ctx, data, filename="EOB mcpfilename 2026-03.pdf", store=store)

    every_scope = AccessContext.all()
    assert "document" not in {t["name"] for t in tools.list_types(every_scope)["types"]}
    with pytest.raises(ScopeError):
        tools.find(every_scope, type_name="document")
    # and not by stumbling onto it without naming the type
    assert tools.find(every_scope, text="mcpfilename")["entities"] == []
    assert not [
        e for e in tools.find(every_scope)["entities"] if "mcpfilename" in str(e["attributes"])
    ]
    # not vacuous: the owner's own context still finds it by that very word
    assert find(doc_ctx, text="mcpfilename")


def test_an_all_scopes_operator_context_is_narrowed_too(candidate: UUID) -> None:
    """`AccessContext.all()` is the operator-script context, and the tool
    surface narrows it like any other — otherwise the flag would only hold for
    contexts that happened to be built narrowly."""
    every_scope = AccessContext.all()
    assert TYPE_BILL not in {t["name"] for t in tools.list_types(every_scope)["types"]}
    with pytest.raises(ScopeError):
        tools.get_entity(every_scope, str(candidate))


# --- episodes (EP1): x-sensitive from the first definition -------------------

EPISODES_CTX = AccessContext.of(
    f"{EPISODES_DOMAIN}:read", f"{EPISODES_DOMAIN}:write", "relationships:read"
)


@pytest.fixture(scope="module")
def episode(seeded: dict[str, UUID]) -> UUID:
    """One synthetic episode and one synthetic playbook version, invented, so
    the episodes domain has something to withhold. Defined and captured in one
    breath: the flag is in the first definition, so there is no unflagged
    moment for these records to be readable in."""
    define_episode_types(EPISODES_CTX)
    capture(
        EPISODES_CTX,
        TYPE_PLAYBOOK,
        {
            "name": "steady days mcpplaybook",
            "version": 1,
            "steps": [{"if": "an early warning sign", "then": "run the checklist"}],
        },
    )
    attributes: dict[str, Any] = {
        "onset_date": "2026-03-01",
        "perturbation_tags": ["mcpepisodetag"],
        "intensity": 5,
    }
    return capture(EPISODES_CTX, TYPE_EPISODE, attributes).entity_id


def test_the_scopes_really_do_reach_the_episode_without_the_tools(episode: UUID) -> None:
    """Not vacuous: the owner reads episodes fine through the kernel services;
    only the model-facing surface is narrowed."""
    assert episode in {e.id for e in find(EPISODES_CTX, type_name=TYPE_EPISODE)}
    assert has(EPISODES_CTX, f"{EPISODES_DOMAIN}:read")


def test_agent_read_context_drops_the_episodes_domain(episode: UUID) -> None:
    narrowed = tools.agent_read_context(EPISODES_CTX)
    assert "relationships:read" in narrowed.scopes
    assert not any(scope.startswith(f"{EPISODES_DOMAIN}:") for scope in narrowed.scopes)


def test_the_agent_tools_withhold_both_episode_types(episode: UUID) -> None:
    """Both types carry the flag themselves — neither rides along on the
    other's — and the whole domain is withheld, whichever context asks."""
    listed = {t["name"] for t in tools.list_types(AccessContext.all())["types"]}
    assert TYPE_EPISODE not in listed
    assert TYPE_PLAYBOOK not in listed

    with pytest.raises(ScopeError):
        tools.find(EPISODES_CTX, type_name=TYPE_EPISODE)
    with pytest.raises(ScopeError):
        tools.find(EPISODES_CTX, type_name=TYPE_PLAYBOOK)
    with pytest.raises(ScopeError):
        tools.history(EPISODES_CTX, str(episode))
    with pytest.raises(ScopeError):
        tools.get_entity(AccessContext.all(), str(episode))


def test_an_untyped_or_text_search_cannot_reach_an_episode(episode: UUID) -> None:
    """A model that does not name the type still must not stumble onto an
    episode or a playbook through a broad search."""
    every_scope = AccessContext.all()
    assert str(episode) not in {e["id"] for e in tools.find(every_scope)["entities"]}
    assert tools.find(every_scope, text="mcpepisodetag")["entities"] == []
    assert tools.find(every_scope, text="mcpplaybook")["entities"] == []
    # not vacuous: the owner's own context finds both by those very words
    assert find(EPISODES_CTX, text="mcpepisodetag")
    assert find(EPISODES_CTX, text="mcpplaybook")
