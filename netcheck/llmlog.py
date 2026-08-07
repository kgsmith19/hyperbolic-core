"""Extract genuine API errors from LLM CLI transcripts.

Two authoritative signals, never substring matching over whole lines:
  * assistant entries flagged `isApiErrorMessage`
  * `type: system` entries carrying an `error` object

Everything else in a transcript — tool output, user questions, assistant prose
— routinely contains strings like ECONNRESET or 529 while describing a problem
rather than being one. Counting those produced an estimate three orders of
magnitude too high before this module existed.
"""
import json
import re
from pathlib import Path

SOURCES = {"claude-code": Path.home() / ".claude" / "projects",
           "codex": Path.home() / ".codex"}

# Transport-level failures. Checked first: Claude Code labels these
# `error: server_error`, which would otherwise blame Anthropic for a reset that
# happened on the local link.
_NETWORK = re.compile(
    r"ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH"
    r"|socket hang up|fetch failed|Connection error|network error"
    r"|certificate|SSL|TLS handshake", re.I)
_SERVER = re.compile(
    r"\b(429|500|502|503|504|529)\b|overloaded|rate_limit|internal server error"
    r"|service unavailable|bad gateway", re.I)
_CLIENT = re.compile(
    r"\b(400|401|403|404|413)\b|invalid_request|authentication_error"
    r"|permission_error|context length|too many tokens", re.I)


def classify(text, error_field=None):
    """Bucket an error message. Transport beats status: see module docstring."""
    blob = f"{text} {error_field or ''}"
    if _NETWORK.search(blob):
        return "network"
    if _SERVER.search(blob):
        return "server"
    if _CLIENT.search(blob):
        return "client"
    return "unknown"


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    return ""


def parse_line(line, source):
    """Return an error dict, or None if this entry is not an API error."""
    try:
        o = json.loads(line)
    except (ValueError, TypeError):
        return None
    if not isinstance(o, dict):
        return None

    if o.get("isApiErrorMessage"):
        detail = _text(o.get("message", {}).get("content"))
    elif o.get("type") == "system" and isinstance(o.get("error"), dict):
        detail = str(o["error"].get("message", "")).strip()
    else:
        return None

    if not detail:
        return None
    return {"ts": o.get("timestamp"), "source": source,
            "kind": classify(detail, o.get("error") if isinstance(o.get("error"), str) else None),
            "detail": detail[:500]}


def _tail(path, start):
    """The complete lines added to `path` since byte `start`, plus the offset
    after them — or None when there is nothing usable to read.

    Stops at the last newline, so a transcript being appended to right now
    never yields a half-parsed record. A file shorter than our offset was
    rotated or truncated, which makes the offset meaningless, so we re-read
    it whole rather than seeking past its end.
    """
    try:
        size = path.stat().st_size
        if size < start:
            start = 0
        if size == start:
            return None
        with path.open("rb") as f:
            f.seek(start)
            raw = f.read()
    except OSError:
        return None

    cut = raw.rfind(b"\n") + 1              # ignore any partial trailing line
    if not cut:
        return None
    return raw[:cut].decode("utf-8", "replace"), start + cut


def scan(root, offsets, source="claude-code"):
    """Read only what is new since `offsets`, returning (errors, new_offsets)."""
    root = Path(root)
    if not root.exists():
        return [], dict(offsets)

    errors, new = [], dict(offsets)
    for path in sorted(root.rglob("*.jsonl")):
        tail = _tail(path, offsets.get(str(path), 0))
        if tail is None:
            continue
        text, new[str(path)] = tail
        for line in text.splitlines():
            err = parse_line(line, source) if line.strip() else None
            if err and err["ts"]:
                errors.append(err)
    return errors, new


def scan_all(offsets):
    """Scan every known LLM CLI transcript root."""
    errors, merged = [], dict(offsets)
    for source, root in SOURCES.items():
        found, merged = scan(root, merged, source)
        errors.extend(found)
    return errors, merged
