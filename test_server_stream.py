"""E2E tests for live research progress streaming (HTTP + real browser).

The /api/research endpoint must stream progress messages while the search
runs so the UI can show the user what is happening, then finish with the
full result payload.
"""

import json
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch

from backend.research.types import ResearchRun, SearchOptions, SpendReport
from backend.server import web_server


def _fake_run_factory(messages, delay=0.0, result_status="success"):
    """Build a run_search stub that emits progress messages then a canned run."""

    def fake_run_search(*, topic, watchlist, options, run_id="default", progress_callback=None, **kwargs):
        for message in messages:
            if progress_callback:
                progress_callback(message)
            if delay:
                time.sleep(delay)
        run = ResearchRun(
            topic=topic,
            options=options,
            queries=[],
            evidence=[
                {
                    "title": "Example source",
                    "url": "https://example.org/source",
                    "snippet": "A snippet about solid electrolytes.",
                    "excerpt": "Excerpt text.",
                    "score": 87.5,
                }
            ],
            summary="Cloud or local summary.",
            spend=SpendReport(model=options.model),
            duration_sec=0.2,
            archive_path="reports/example.md",
            status=result_status,
            report_markdown="# Report",
        )
        return run

    return fake_run_search


class _ServerHarness:
    """Starts the real handler on an ephemeral port with run_search stubbed."""

    def __init__(self, messages, delay=0.0):
        self.messages = messages
        self.delay = delay
        self.httpd = None
        self.thread = None
        self._patcher = None

    def __enter__(self):
        fake = _fake_run_factory(self.messages, delay=self.delay)
        self._patcher = patch.object(web_server, "run_search", side_effect=fake)
        self._patcher.start()
        self.httpd = web_server.ThreadedUIServer(("127.0.0.1", 0), web_server.SafeResearchRequestHandler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self._patcher.stop()


class TestResearchStreamHTTP(unittest.TestCase):
    """POST /api/research must stream progress events, then the result."""

    MESSAGES = [
        "Planning search queries...",
        "Seeding frontier across 1 query angle(s)...",
        "Retrieving batch at depth 0...",
        "Ranking corpus locally...",
        "Writing report and archiving findings...",
    ]

    def _post(self, payload: dict, timeout: float = 15.0):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/research",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return urllib.request.urlopen(request, timeout=timeout)

    def test_progress_events_stream_before_result(self):
        with _ServerHarness(self.MESSAGES) as harness:
            self.port = harness.port
            with self._post({"topic": "solid batteries", "watchlist": ""}) as resp:
                self.assertIn("text/event-stream", resp.headers.get("Content-Type", ""))
                body = resp.read().decode("utf-8")

        events = []
        for raw_event in body.split("\n\n"):
            for line in raw_event.splitlines():
                if line.startswith("data:"):
                    events.append(json.loads(line[5:].strip()))

        self.assertGreaterEqual(len(events), len(self.MESSAGES) + 1)
        types = [event["type"] for event in events]
        self.assertTrue(all(t in ("progress", "result", "error") for t in types))
        self.assertEqual(types[0], "progress")
        self.assertEqual(types[-1], "result")

        messages = [event["message"] for event in events if event["type"] == "progress"]
        self.assertEqual(messages, self.MESSAGES)

        result = events[-1]
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["topic"], "solid batteries")
        self.assertTrue(result["evidence"])

    def test_research_still_rejects_mode(self):
        with _ServerHarness(self.MESSAGES) as harness:
            self.port = harness.port
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                with self._post({"topic": "t", "watchlist": "", "mode": "full"}):
                    pass
            self.assertEqual(ctx.exception.code, 400)
            self.assertIn("mode", json.loads(ctx.exception.read().decode("utf-8"))["error"])

    def test_safety_error_streams_error_event(self):
        def blocked_run_search(**kwargs):
            from backend.privacy import SafetyError

            raise SafetyError("blocked by local safety guard")

        with _ServerHarness(self.MESSAGES) as harness:
            self.port = harness.port
            with patch.object(web_server, "run_search", side_effect=blocked_run_search):
                with self._post({"topic": "t", "watchlist": ""}) as resp:
                    body = resp.read().decode("utf-8")

        events = []
        for raw_event in body.split("\n\n"):
            for line in raw_event.splitlines():
                if line.startswith("data:"):
                    events.append(json.loads(line[5:].strip()))
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("Blocked by local safety guard", events[-1]["error"])


class TestResearchStreamBrowser(unittest.TestCase):
    """Real browser: the status box must update while the run is in flight."""

    MESSAGES = [
        "Planning search queries...",
        "Seeding frontier across connectors...",
        "Retrieving batch at depth 0...",
        "Writing report and archiving findings...",
    ]

    def test_browser_shows_live_progress_then_results(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.skipTest("playwright not installed")

        with _ServerHarness(self.MESSAGES, delay=0.35) as harness:
            base = f"http://127.0.0.1:{harness.port}"
            try:
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    page = browser.new_page()
                    page.goto(base, wait_until="domcontentloaded")

                    page.fill("#topic", "solid-state batteries")
                    page.click("#run-btn")

                    # Live updates: the status box must show early AND late
                    # messages while the request is still in flight.
                    page.wait_for_function(
                        "document.getElementById('status-box').innerText.includes('%s')"
                        % self.MESSAGES[0],
                        timeout=10000,
                    )
                    page.wait_for_function(
                        "document.getElementById('status-box').innerText.includes('%s')"
                        % self.MESSAGES[-1],
                        timeout=10000,
                    )

                    # The final result renders and the status box clears.
                    page.wait_for_selector("#results-section", state="visible", timeout=10000)
                    self.assertEqual(page.text_content("#result-status-badge").strip(), "Complete")

                    cancel_visible = page.is_visible("#cancel-btn")
                    self.assertFalse(cancel_visible)

                    browser.close()
            except Exception as err:
                if "Executable doesn't exist" in str(err) or "BrowserType" in str(err):
                    self.skipTest(f"chromium not installed: {err}")
                raise


if __name__ == "__main__":
    unittest.main()
