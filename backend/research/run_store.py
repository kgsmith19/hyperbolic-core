"""Local-only, privacy-safe durable research run storage."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import tempfile
from typing import Any

from backend.privacy.watchlist_redactor import assert_safe_to_send, redact
from backend.research.types import Evidence, SearchOptions


@dataclass(frozen=True)
class RunCheckpoint:
    run_id: str
    status: str
    phase: str
    stop_reason: str | None
    ledger_path: str


class RunStoreError(RuntimeError):
    """Raised when persisted run state is absent, corrupt, or unsafe to resume."""


class RunStore:
    """Own sanitized run files; never expose their contents to retrieval workers."""

    SCHEMA_VERSION = 1
    _PHASES = frozenset({
        "created", "planned", "searching", "fetching", "expanding",
        "ranking", "synthesizing", "reporting", "completed",
    })
    _TERMINAL_REASONS = {
        "success": {"completed", "low_information_gain", "document_budget", "time_budget"},
        "cancelled": {"cancelled"},
        "interrupted": {"internal_error"},
        "failed": {"provider_failure", "internal_error"},
    }

    def __init__(self, root: str | Path = "research_runs"):
        self.root = Path(root).resolve()
        self._run_id: str | None = None

    def create(
        self, run_id: str, topic: str, options: SearchOptions, watchlist: list[str]
    ) -> RunCheckpoint:
        run_dir = self._run_dir(run_id)
        if run_dir.exists():
            raise RunStoreError(f"run already exists: {run_id}")
        run_dir.mkdir(parents=True)
        self._run_id = run_id
        manifest = {
            "schema_version": self.SCHEMA_VERSION,
            "run_id": run_id,
            "topic": self._sanitize(topic, watchlist),
            "options": self._sanitize(asdict(options), watchlist),
            "phase": "created",
            "status": "running",
            "stop_reason": None,
            "budget": {},
            "frontier": None,
            "latest_event_sequence": 0,
        }
        self._write_manifest(manifest)
        self._append_event("created", {"topic": manifest["topic"]}, watchlist)
        return self._checkpoint(manifest)

    def load(self, run_id: str, watchlist: list[str]) -> dict:
        run_dir = self._run_dir(run_id)
        manifest_path = run_dir / "manifest.json"
        if not manifest_path.exists():
            raise RunStoreError(f"run manifest not found: {run_id}")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RunStoreError(f"manifest is corrupt for run {run_id}") from exc
        if not isinstance(manifest, dict) or manifest.get("schema_version") != self.SCHEMA_VERSION:
            raise RunStoreError(f"unsupported manifest schema for run {run_id}")
        if manifest.get("run_id") != run_id:
            raise RunStoreError(f"manifest run identity mismatch for {run_id}")
        try:
            assert_safe_to_send(manifest, watchlist)
        except Exception as exc:
            raise RunStoreError(f"manifest contains unsafe persisted data for {run_id}") from exc
        self._run_id = run_id
        return {"manifest": manifest, "events": self._read_jsonl(run_dir / "events.jsonl", watchlist),
                "evidence": self._read_jsonl(run_dir / "evidence.jsonl", watchlist)}

    def checkpoint(self, phase: str, payload: dict, watchlist: list[str]) -> None:
        if phase not in self._PHASES - {"completed"}:
            raise ValueError(f"invalid non-terminal phase: {phase}")
        manifest = self._manifest()
        safe_payload = self._sanitize(payload, watchlist)
        manifest["phase"] = phase
        for key in ("frontier", "budget", "queries"):
            if key in safe_payload:
                manifest[key] = safe_payload[key]
        self._append_event("checkpoint", {"phase": phase, **safe_payload}, watchlist, manifest)
        self._write_manifest(manifest)

    def append_evidence(self, evidence: Evidence, watchlist: list[str]) -> None:
        run_dir = self._active_dir()
        record = self._sanitize(asdict(evidence), watchlist)
        self._append_jsonl(run_dir / "evidence.jsonl", record)
        self._append_event("evidence", record, watchlist)

    def reopen_for_resume(self, watchlist: list[str]) -> None:
        """Mark a resumable local run active again before fresh exploration."""
        manifest = self._manifest()
        if manifest.get("status") == "success":
            raise RunStoreError("completed successful runs cannot be resumed")
        manifest.update({"status": "running", "stop_reason": None})
        self._append_event("resumed", {}, watchlist, manifest)
        self._write_manifest(manifest)

    def finish(self, status: str, stop_reason: str, watchlist: list[str]) -> None:
        if stop_reason not in self._TERMINAL_REASONS.get(status, set()):
            raise ValueError(f"invalid terminal status/stop reason: {status}/{stop_reason}")
        manifest = self._manifest()
        if manifest.get("status") in self._TERMINAL_REASONS:
            raise RunStoreError("run is already terminal")
        manifest.update({"phase": "completed", "status": status, "stop_reason": stop_reason})
        self._append_event("finished", {"status": status, "stop_reason": stop_reason}, watchlist, manifest)
        self._write_manifest(manifest)

    def _run_dir(self, run_id: str) -> Path:
        if not isinstance(run_id, str) or not run_id or Path(run_id).name != run_id or run_id in {".", ".."}:
            raise RunStoreError("invalid run identifier")
        run_dir = self.root / run_id
        if self.root not in run_dir.resolve().parents:
            raise RunStoreError("run identifier escapes ledger root")
        return run_dir

    def _active_dir(self) -> Path:
        if self._run_id is None:
            raise RunStoreError("no active run")
        return self._run_dir(self._run_id)

    def _manifest(self) -> dict:
        run_dir = self._active_dir()
        try:
            manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RunStoreError("manifest is corrupt") from exc
        if not isinstance(manifest, dict) or manifest.get("schema_version") != self.SCHEMA_VERSION:
            raise RunStoreError("unsupported manifest schema")
        return manifest

    def _checkpoint(self, manifest: dict) -> RunCheckpoint:
        return RunCheckpoint(manifest["run_id"], manifest["status"], manifest["phase"],
                             manifest["stop_reason"], str(self._active_dir()))

    def _append_event(self, kind: str, payload: dict, watchlist: list[str], manifest: dict | None = None) -> None:
        current = manifest if manifest is not None else self._manifest()
        sequence = int(current.get("latest_event_sequence", 0)) + 1
        event = self._sanitize({"sequence": sequence, "kind": kind, "payload": payload}, watchlist)
        self._append_jsonl(self._active_dir() / "events.jsonl", event)
        current["latest_event_sequence"] = sequence
        if manifest is None:
            self._write_manifest(current)

    @staticmethod
    def _sanitize(value: Any, watchlist: list[str]) -> Any:
        if isinstance(value, str):
            value = redact(value, watchlist)
        elif isinstance(value, dict):
            value = {str(key): RunStore._sanitize(item, watchlist) for key, item in value.items()}
        elif isinstance(value, (list, tuple)):
            value = [RunStore._sanitize(item, watchlist) for item in value]
        elif value is not None and not isinstance(value, (bool, int, float)):
            value = redact(str(value), watchlist)
        assert_safe_to_send(value, watchlist)
        return value

    def _write_manifest(self, manifest: dict) -> None:
        target = self._active_dir() / "manifest.json"
        self._atomic_json(target, manifest)

    @staticmethod
    def _atomic_json(target: Path, value: dict) -> None:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=target.parent, delete=False) as handle:
            json.dump(value, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
            temporary = handle.name
        os.replace(temporary, target)

    @staticmethod
    def _append_jsonl(target: Path, value: dict) -> None:
        with target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(value, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    @staticmethod
    def _read_jsonl(target: Path, watchlist: list[str]) -> list[dict]:
        if not target.exists():
            return []
        rows = []
        lines = target.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                if index == len(lines) - 1:
                    break
                raise RunStoreError(f"malformed ledger event at line {index + 1}") from exc
            assert_safe_to_send(value, watchlist)
            rows.append(value)
        return rows
