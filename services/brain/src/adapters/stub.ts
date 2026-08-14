/**
 * Codex/Gemini stub adapters (07-brain-architecture.md section 7.4, this
 * issue's own scope: "Codex and Gemini stub adapters whose probe returns
 * not-available"). Unlike claude-code.ts, these have no ACC kernel
 * counterpart to spawn at all (apps/agentic-command-center/kernel/adapters/
 * only ships claude-code.mjs) -- these exist purely so router.ts's routing
 * rule and fallback logic have a real, typed HarnessAdapter to route
 * *away* from, never toward, until each gets its own implementation issue
 * (07 gate question 2).
 */
import type { AdapterInvocation, HarnessAdapter, HarnessId, HarnessSession, ProbeResult } from "./types.ts";

class StubAdapter implements HarnessAdapter {
  readonly id: HarnessId;

  constructor(id: HarnessId) {
    this.id = id;
  }

  async probe(): Promise<ProbeResult> {
    return { ok: false, version: "" };
  }

  async start(inv: AdapterInvocation): Promise<HarnessSession> {
    throw new Error(`${this.id} adapter: not available yet (stub -- see 07 gate question 2); task ${inv.taskId} cannot dispatch to it`);
  }

  async resume(): Promise<HarnessSession> {
    throw new Error(`${this.id} adapter: not available yet (stub)`);
  }

  async cancel(): Promise<void> {
    // Nothing was ever started; cancelling a stub is always a no-op.
  }
}

export const codexAdapter: HarnessAdapter = new StubAdapter("codex");
export const geminiAdapter: HarnessAdapter = new StubAdapter("gemini");
