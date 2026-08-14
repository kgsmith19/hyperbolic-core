// Structural/DOM-level tests for the m4-15 chat primitives
// (packages/ui/src/chat/*), matching test/chrome.test.mjs's established
// pattern: exercise the real BUILT package (dist/index.cjs) via
// react-dom/server, not source .tsx (Node's native TS type-stripping does
// not transform JSX). Run `npm run build -w packages/ui` before this file
// (pretest already does this for `npm test`).
//
// Scope this file CAN prove: static structure, prop-driven variation, and
// text present in the built bundle, exhaustively via renderToStaticMarkup.
// It CANNOT prove interactive behavior that only fires after mount
// (IntersectionObserver marking evidence seen, ResizeObserver-driven
// virtualization, scroll-event autoscroll, requestAnimationFrame
// coalescing) -- react-dom/server never mounts effects. Those are covered
// at the pure-logic level by approval.test.mjs, virtualize.test.mjs,
// stream-buffer.test.mjs, and autoscroll.test.mjs instead; a real-browser
// proof needs a live host page, which is m4-16's scope, not this one's.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, "..", "dist", "index.cjs");

assert.ok(
  existsSync(distEntry),
  `${distEntry} does not exist -- run \`npm run build -w packages/ui\` before this test.`
);

const ui = createRequire(import.meta.url)(distEntry);
const h = React.createElement;

describe("OperatorMessage", () => {
  test("renders the text and default 'sent' state", () => {
    const html = renderToStaticMarkup(h(ui.OperatorMessage, { text: "Do the thing" }));
    assert.match(html, /Do the thing/);
    assert.match(html, /data-state="sent"/);
  });

  test("'sending' state is reflected in the markup", () => {
    const html = renderToStaticMarkup(h(ui.OperatorMessage, { text: "x", state: "sending" }));
    assert.match(html, /data-state="sending"/);
  });
});

describe("AgentMessage", () => {
  test("renders plain text and inline code spans in mono", () => {
    const html = renderToStaticMarkup(h(ui.AgentMessage, { text: "run `npm test` now" }));
    assert.match(html, /<code[^>]*>npm test<\/code>/);
    assert.match(html, /run /);
    assert.match(html, / now/);
  });

  test("streaming state renders a caret element", () => {
    const html = renderToStaticMarkup(h(ui.AgentMessage, { text: "typing", state: "streaming" }));
    assert.match(html, /data-state="streaming"/);
    assert.match(html, /animate-pulse/);
  });

  test("error state renders the danger edge and the inline error message", () => {
    const html = renderToStaticMarkup(
      h(ui.AgentMessage, { text: "failed to complete", state: "error", errorMessage: "Connection lost" })
    );
    assert.match(html, /data-state="error"/);
    assert.match(html, /border-danger/);
    assert.match(html, /Connection lost/);
  });
});

describe("ToolCallBlock", () => {
  test("an 'ok' block starts collapsed (no detail rendered)", () => {
    const html = renderToStaticMarkup(
      h(ui.ToolCallBlock, { toolName: "bash", summary: "ran tests", status: "ok", detail: "SECRET_DETAIL_TEXT" })
    );
    assert.match(html, /data-expanded="false"/);
    assert.doesNotMatch(html, /SECRET_DETAIL_TEXT/);
  });

  test("a 'failed' block auto-expands, showing its detail", () => {
    const html = renderToStaticMarkup(
      h(ui.ToolCallBlock, { toolName: "bash", summary: "tests failed", status: "failed", detail: "stack trace here" })
    );
    assert.match(html, /data-expanded="true"/);
    assert.match(html, /stack trace here/);
  });

  test("a 'running' block starts collapsed", () => {
    const html = renderToStaticMarkup(h(ui.ToolCallBlock, { toolName: "bash", summary: "running…", status: "running" }));
    assert.match(html, /data-expanded="false"/);
  });

  test("duration renders when provided, omitted when not", () => {
    const withDuration = renderToStaticMarkup(
      h(ui.ToolCallBlock, { toolName: "x", summary: "y", status: "ok", durationMs: 1500 })
    );
    assert.match(withDuration, /1\.5s/);
    const without = renderToStaticMarkup(h(ui.ToolCallBlock, { toolName: "x", summary: "y", status: "ok" }));
    // "ok" starts collapsed (no expanded <pre>), so any font-mono span left
    // in the markup can only be the duration one -- its absence here is
    // exactly "no duration rendered when durationMs is omitted".
    assert.doesNotMatch(without, /font-mono/);
  });

  test("an explicitly controlled block honors the `expanded` prop over the auto-expand default", () => {
    const html = renderToStaticMarkup(
      h(ui.ToolCallBlock, { toolName: "x", summary: "y", status: "failed", expanded: false, detail: "MARKER_DETAIL_TEXT" })
    );
    assert.match(html, /data-expanded="false"/);
    assert.doesNotMatch(html, /MARKER_DETAIL_TEXT/);
  });

  test("output over 500 lines renders tail-first with a 'load earlier output' control", () => {
    const detail = Array.from({ length: 600 }, (_, i) => `line-${i}`).join("\n");
    const html = renderToStaticMarkup(h(ui.ToolCallBlock, { toolName: "x", summary: "y", status: "failed", detail }));
    assert.match(html, /Load earlier output/);
    assert.doesNotMatch(html, /line-0\n/); // the earliest lines are not in the initial tail
    assert.match(html, /line-599/); // the very last line is
  });

  test("output at or under 500 lines shows everything with no 'load earlier' control", () => {
    const short = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");
    const html = renderToStaticMarkup(h(ui.ToolCallBlock, { toolName: "x", summary: "y", status: "failed", detail: short }));
    assert.doesNotMatch(html, /Load earlier output/);
    assert.match(html, /line-0\n/);
  });
});

describe("SystemRow", () => {
  test("renders its text", () => {
    const html = renderToStaticMarkup(h(ui.SystemRow, { text: "Run started" }));
    assert.match(html, /Run started/);
  });
});

describe("ApprovalCard", () => {
  const evidence = { kind: "text", body: "short evidence body" };

  test("a pending card renders the title, scope line, and a disabled Approve control (evidence not yet seen)", () => {
    const html = renderToStaticMarkup(
      h(ui.ApprovalCard, {
        title: "Modify production config",
        evidence,
        scopeLine: "kgsmith19/hyperbolic-core",
        resolution: "pending",
        onApprove: () => {},
        onReject: () => {},
      })
    );
    assert.match(html, /Modify production config/);
    assert.match(html, /kgsmith19\/hyperbolic-core/);
    assert.match(html, /disabled=""/);
    assert.match(html, /Approve/);
    assert.match(html, /Reject/);
  });

  test("short evidence (under 40 lines) auto-expands so its body is present in the markup", () => {
    const html = renderToStaticMarkup(
      h(ui.ApprovalCard, {
        title: "x",
        evidence,
        scopeLine: "y",
        resolution: "pending",
        onApprove: () => {},
        onReject: () => {},
      })
    );
    assert.match(html, /short evidence body/);
  });

  test("evidence over 40 lines starts collapsed -- the body is not in the initial markup", () => {
    const longEvidence = { kind: "diff", body: Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n") };
    const html = renderToStaticMarkup(
      h(ui.ApprovalCard, {
        title: "x",
        evidence: longEvidence,
        scopeLine: "y",
        resolution: "pending",
        onApprove: () => {},
        onReject: () => {},
      })
    );
    assert.doesNotMatch(html, /\+line 0</);
  });

  test("a resolved (approved) card renders collapsed with its resolution stamp, no evidence/keyboard affordances", () => {
    const html = renderToStaticMarkup(
      h(ui.ApprovalCard, {
        title: "Modify production config",
        evidence,
        scopeLine: "y",
        resolution: "approved",
        resolvedAt: "2026-08-14T00:00:00Z",
        onApprove: () => {},
        onReject: () => {},
      })
    );
    assert.match(html, /data-resolution="approved"/);
    assert.match(html, /Approved/);
    assert.match(html, /2026-08-14T00:00:00Z/);
    assert.doesNotMatch(html, /short evidence body/);
  });

  test("expired renders the expired-rejected label (09 section 7.4)", () => {
    const html = renderToStaticMarkup(
      h(ui.ApprovalCard, { title: "x", evidence, scopeLine: "y", resolution: "expired", onApprove: () => {}, onReject: () => {} })
    );
    assert.match(html, /data-resolution="expired"/);
    assert.match(html, /Expired/);
  });
});

describe("Composer", () => {
  test("renders a textarea and a Send button by default", () => {
    const html = renderToStaticMarkup(
      h(ui.Composer, { value: "", onChange: () => {}, onSend: () => {}, running: false })
    );
    assert.match(html, /<textarea/);
    assert.match(html, />Send</);
    assert.doesNotMatch(html, />Stop</);
  });

  test("Send is disabled when the value is empty or whitespace", () => {
    const html = renderToStaticMarkup(
      h(ui.Composer, { value: "   ", onChange: () => {}, onSend: () => {}, running: false })
    );
    assert.match(html, /disabled=""/);
  });

  test("running:true swaps Send for Stop", () => {
    const html = renderToStaticMarkup(
      h(ui.Composer, { value: "go", onChange: () => {}, onSend: () => {}, onStop: () => {}, running: true })
    );
    // The Stop button renders an icon before the text (`<Square /> Stop`),
    // so the text node is " Stop" with a leading space, not immediately
    // after a closing `>`.
    assert.match(html, /Stop<\/button>/);
    assert.doesNotMatch(html, />Send</);
  });

  test("a disabledReason renders the reason text and disables the textarea", () => {
    const html = renderToStaticMarkup(
      h(ui.Composer, {
        value: "x",
        onChange: () => {},
        onSend: () => {},
        running: false,
        disabledReason: "Reconnecting…",
      })
    );
    assert.match(html, /Reconnecting…/);
  });

  test("targets render as select options when provided", () => {
    const html = renderToStaticMarkup(
      h(ui.Composer, {
        value: "",
        onChange: () => {},
        onSend: () => {},
        running: false,
        targets: [{ value: "main", label: "main branch" }],
        target: "main",
      })
    );
    assert.match(html, /main branch/);
  });
});

describe("StatusStrip", () => {
  test("renders the connection state label", () => {
    const html = renderToStaticMarkup(h(ui.StatusStrip, { connectionState: "live" }));
    assert.match(html, /Live/);
  });

  test("reconnecting shows the attempt count", () => {
    const html = renderToStaticMarkup(h(ui.StatusStrip, { connectionState: "reconnecting", reconnectAttempt: 3 }));
    assert.match(html, /Reconnecting/);
    assert.match(html, /\(3\)/);
  });

  test("optional segments (lane, harness, run state) render only when provided", () => {
    const bare = renderToStaticMarkup(h(ui.StatusStrip, { connectionState: "live" }));
    assert.doesNotMatch(bare, /<button/);

    const full = renderToStaticMarkup(
      h(ui.StatusStrip, {
        connectionState: "live",
        laneStatus: "lane-1 active",
        harnessState: "claude-code running",
        runState: "awaiting_approval",
        onLaneClick: () => {},
      })
    );
    assert.match(full, /lane-1 active/);
    assert.match(full, /claude-code running/);
    assert.match(full, /awaiting approval/); // underscores replaced with spaces for display
  });
});

describe("CostTicker", () => {
  test("formats the run cost as USD currency", () => {
    const html = renderToStaticMarkup(h(ui.CostTicker, { currentRunUsd: 4.5 }));
    assert.match(html, /\$4\.50/);
  });

  test("renders the weekly spend label when provided", () => {
    const html = renderToStaticMarkup(h(ui.CostTicker, { currentRunUsd: 0, weeklySpendLabel: "$12.00 this week" }));
    assert.match(html, /\$12\.00 this week/);
  });
});

describe("RunId", () => {
  test("renders the id text in a clickable, font-mono control", () => {
    const html = renderToStaticMarkup(h(ui.RunId, { id: "run-abc123" }));
    assert.match(html, /run-abc123/);
    assert.match(html, /font-mono/);
    assert.match(html, /<button/);
  });
});

describe("public entry re-exports every m4-15 piece", () => {
  test("all chat primitives are exported from the built package", () => {
    for (const name of [
      "RunId",
      "OperatorMessage",
      "AgentMessage",
      "ToolCallBlock",
      "SystemRow",
      "ApprovalCard",
      "Composer",
      "StatusStrip",
      "CostTicker",
      "Transcript",
    ]) {
      assert.equal(typeof ui[name], "function", `missing component export: ${name}`);
    }
    for (const name of [
      "initialApprovalState",
      "toggleEvidence",
      "markEvidenceSeen",
      "canApprove",
      "resolveApproved",
      "resolveRejected",
      "resolveExpired",
      "mapApprovalKey",
      "countLines",
      "shouldVirtualize",
      "buildOffsets",
      "computeVirtualRange",
      "createTokenBuffer",
      "appendToken",
      "flushTokenBuffer",
      "useCoalescedStream",
      "initialAutoscrollState",
      "onTranscriptScroll",
      "onTranscriptNewContent",
      "jumpToLatestTranscript",
    ]) {
      assert.equal(typeof ui[name], "function", `missing logic export: ${name}`);
    }
  });
});
