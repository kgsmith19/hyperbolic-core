import { test } from "node:test";
import assert from "node:assert/strict";
import { createAttemptController } from "../src/drivers/abort.ts";

test("createAttemptController(): cleanup removes the pending caller abort listener", () => {
  let added: EventListener | undefined;
  let removed: EventListener | undefined;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(_type: string, listener: EventListener) {
      added = listener;
    },
    removeEventListener(_type: string, listener: EventListener) {
      removed = listener;
    },
  } as unknown as AbortSignal;

  const attempt = createAttemptController({ timeoutMs: 60_000, signal });
  try {
    assert.equal(typeof attempt.cleanup, "function");
    attempt.cleanup();
    assert.equal(removed, added);
  } finally {
    clearTimeout(attempt.hardTimer);
  }
});
