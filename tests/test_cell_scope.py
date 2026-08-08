from pathlib import Path

import pytest

from scripts.check_cell_scope import (
    load_ownership,
    merge_ownership,
    parse_declared_cells,
    validate_scope,
)


def _constitution(root: Path, cell: str, owns: str) -> None:
    path = root / ".agents" / "domains" / cell / "CONSTITUTION.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# {cell}\n\nOwns: {owns}.\n", encoding="utf-8")


def test_load_ownership_reads_constitutions_as_single_source_of_truth(tmp_path: Path) -> None:
    _constitution(tmp_path, "kernel", "`src/kernel/**`, `tests/kernel/**`")
    _constitution(tmp_path, "bills", "`src/domains/bills/**`, `tests/bills/**`")

    assert load_ownership(tmp_path) == {
        "bills": ("src/domains/bills/", "tests/bills/"),
        "kernel": ("src/kernel/", "tests/kernel/"),
    }


def test_base_and_head_ownership_are_unioned_to_prevent_self_unprotection() -> None:
    assert merge_ownership(
        {"bills": ("src/domains/bills/",)},
        {"bills": ("src/domains/bills_v2/",)},
    ) == {"bills": ("src/domains/bills/", "src/domains/bills_v2/")}


def test_parse_declared_cells_accepts_one_or_multiple_cells() -> None:
    assert parse_declared_cells("## Work\nCells: bills\n") == {"bills"}
    assert parse_declared_cells("Cells: kernel, bills\n") == {"kernel", "bills"}


def test_same_cell_change_passes_when_declared() -> None:
    ownership = {"bills": ("src/domains/bills/", "tests/bills/")}

    assert validate_scope(
        ["src/domains/bills/verify.py", "tests/bills/test_verify.py", "README.md"],
        {"bills"},
        ownership,
    ) == {"bills"}


def test_explicit_cross_cell_change_passes_only_when_every_cell_is_declared() -> None:
    ownership = {
        "kernel": ("src/kernel/", "supabase/migrations/"),
        "bills": ("src/domains/bills/",),
    }
    changed = ["supabase/migrations/20260808.sql", "src/domains/bills/types.py"]

    assert validate_scope(changed, {"kernel", "bills"}, ownership) == {"kernel", "bills"}
    with pytest.raises(ValueError, match="undeclared cell"):
        validate_scope(changed, {"bills"}, ownership)


def test_blanket_or_unknown_declarations_are_rejected() -> None:
    ownership = {"bills": ("src/domains/bills/",), "kernel": ("src/kernel/",)}

    with pytest.raises(ValueError, match="does not match the touched cells"):
        validate_scope(["src/domains/bills/types.py"], {"bills", "kernel"}, ownership)
    with pytest.raises(ValueError, match="unknown cell"):
        validate_scope(["src/domains/bills/types.py"], {"bills", "made_up"}, ownership)


def test_unowned_change_needs_no_cell_declaration() -> None:
    ownership = {"bills": ("src/domains/bills/",)}

    assert validate_scope(["README.md", "docs/runbook.md"], set(), ownership) == set()


def test_ambiguous_or_malformed_ownership_fails_closed(tmp_path: Path) -> None:
    _constitution(tmp_path, "one", "`src/shared/**`")
    _constitution(tmp_path, "two", "`src/shared/nested/**`")
    with pytest.raises(ValueError, match="overlap"):
        load_ownership(tmp_path)

    bad = tmp_path / ".agents" / "domains" / "two" / "CONSTITUTION.md"
    bad.write_text("# two\n\nOwns: `src/two/*.py`.\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unsupported ownership pattern"):
        load_ownership(tmp_path)


def test_duplicate_cells_line_is_rejected_as_ambiguous() -> None:
    with pytest.raises(ValueError, match="multiple Cells"):
        parse_declared_cells("Cells: bills\nCells: kernel\n")
