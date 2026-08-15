"""LLM transcript scraping.

The whole reason this module exists is that grepping transcripts for error
strings is wildly wrong: `529` matches token counts and request ids, and
`fetch failed` matches any transcript where someone *discussed* an error. The
authoritative signals are the `isApiErrorMessage` flag and system error
entries, so that is what we key on.
"""
import json
import tempfile
import unittest
from pathlib import Path

from netcheck import llmlog


def entry(text, ts="2026-08-05T00:00:00.000Z", **kw):
    o = {"type": "assistant", "timestamp": ts,
         "message": {"model": "<synthetic>", "content": [{"type": "text", "text": text}]}}
    o.update(kw)
    return json.dumps(o)


class ClassifyTest(unittest.TestCase):
    def test_transport_signatures_are_network(self):
        """Criterion 4."""
        for sig in ("ECONNRESET", "ETIMEDOUT", "EPIPE", "socket hang up",
                    "fetch failed", "ENOTFOUND", "EAI_AGAIN", "Connection error."):
            self.assertEqual(llmlog.classify(f"API Error: {sig}"), "network", sig)

    def test_status_signatures_are_server(self):
        for sig in ("429 rate_limit_error", "500 Internal server error",
                    "502 Bad Gateway", "503 Service Unavailable",
                    "529 overloaded_error"):
            self.assertEqual(llmlog.classify(f"API Error: {sig}"), "server", sig)

    def test_request_problems_are_client(self):
        for sig in ("400 invalid_request_error", "401 authentication_error",
                    "403 permission_error"):
            self.assertEqual(llmlog.classify(f"API Error: {sig}"), "client", sig)

    def test_transport_wins_over_the_generic_server_error_label(self):
        """Claude Code tags transport failures `error: server_error`.

        Believing that label would blame Anthropic for a reset that happened on
        this machine's own link — the exact misdiagnosis this tool prevents.
        """
        self.assertEqual(
            llmlog.classify("API Error: Unable to connect to API (ECONNRESET)",
                            error_field="server_error"),
            "network")


class ScanTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.addCleanup(self.dir.cleanup)

    def write(self, name, lines):
        p = self.root / name
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return p

    def test_finds_a_real_api_error(self):
        self.write("a.jsonl", [entry("API Error: Unable to connect to API (ECONNRESET)",
                                     isApiErrorMessage=True, error="server_error")])
        errors, _ = llmlog.scan(self.root, {})
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["kind"], "network")
        self.assertEqual(errors[0]["ts"], "2026-08-05T00:00:00.000Z")
        self.assertEqual(errors[0]["source"], "claude-code")

    def test_finds_system_connection_errors(self):
        self.write("a.jsonl", [json.dumps({
            "type": "system", "timestamp": "2026-08-05T00:01:00.000Z",
            "error": {"message": "Connection error.", "format": "text"}})])
        errors, _ = llmlog.scan(self.root, {})
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["kind"], "network")

    def test_bare_529_in_ordinary_text_is_not_an_error(self):
        """Criterion 5 — the adversarial case that broke the naive estimate."""
        self.write("a.jsonl", [
            entry("That run cost 529 tokens and returned id req_5290."),
            json.dumps({"type": "user", "timestamp": "2026-08-05T00:02:00.000Z",
                        "message": {"role": "user",
                                    "content": "why do I keep seeing ECONNRESET?"}}),
        ])
        errors, _ = llmlog.scan(self.root, {})
        self.assertEqual(errors, [])

    def test_tool_output_mentioning_errors_is_not_an_error(self):
        """Transcripts contain logs *about* failures. Those are not failures."""
        self.write("a.jsonl", [json.dumps({
            "type": "user", "timestamp": "2026-08-05T00:03:00.000Z",
            "toolUseResult": {"stdout": "curl: (56) Recv failure: ECONNRESET"}})])
        errors, _ = llmlog.scan(self.root, {})
        self.assertEqual(errors, [])

    def test_rescan_from_offset_yields_no_duplicates(self):
        """Criterion 6."""
        p = self.write("a.jsonl", [entry("API Error: fetch failed",
                                         isApiErrorMessage=True)])
        first, offsets = llmlog.scan(self.root, {})
        self.assertEqual(len(first), 1)

        second, offsets = llmlog.scan(self.root, offsets)
        self.assertEqual(second, [])

        with p.open("a", encoding="utf-8") as f:
            f.write(entry("API Error: ETIMEDOUT", ts="2026-08-05T00:04:00.000Z",
                          isApiErrorMessage=True) + "\n")
        third, _ = llmlog.scan(self.root, offsets)
        self.assertEqual(len(third), 1)
        self.assertEqual(third[0]["ts"], "2026-08-05T00:04:00.000Z")

    def test_partial_trailing_line_is_not_consumed(self):
        """The file is being appended to live; half a line must not be parsed
        and must not advance the offset past itself."""
        p = self.root / "a.jsonl"
        p.write_text(entry("API Error: EPIPE", isApiErrorMessage=True) + "\n"
                     + '{"type":"assist', encoding="utf-8")

        errors, offsets = llmlog.scan(self.root, {})
        self.assertEqual(len(errors), 1)

        with p.open("a", encoding="utf-8") as f:
            f.write('ant","timestamp":"2026-08-05T00:05:00.000Z",'
                    '"isApiErrorMessage":true,"message":{"content":'
                    '[{"type":"text","text":"API Error: ECONNRESET"}]}}\n')
        rest, _ = llmlog.scan(self.root, offsets)
        self.assertEqual(len(rest), 1)
        self.assertEqual(rest[0]["kind"], "network")

    def test_truncated_file_restarts_from_zero(self):
        """A rotated log is shorter than our stored offset; seeking there would
        silently skip every new line."""
        p = self.write("a.jsonl", [entry("x")] * 20)
        _, offsets = llmlog.scan(self.root, {})
        p.write_text(entry("API Error: ECONNRESET", isApiErrorMessage=True) + "\n",
                     encoding="utf-8")

        errors, _ = llmlog.scan(self.root, offsets)
        self.assertEqual(len(errors), 1)

    def test_missing_root_is_unavailable_not_a_crash(self):
        errors, offsets = llmlog.scan(self.root / "nope", {})
        self.assertEqual(errors, [])
        self.assertEqual(offsets, {})


if __name__ == "__main__":
    unittest.main()
