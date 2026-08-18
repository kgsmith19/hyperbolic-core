// TEMPORARY seeded canary for issue #211's sensitivity demonstration.
// Proves a deliberately-failing NESTED subtest is named in the ACC Windows
// lane's spec output and junit evidence artifact. Reverted before merge.
import { test } from 'node:test';
import assert from 'node:assert';

test('canary-211 outer', async (t) => {
  await t.test('canary-211 seeded nested failure -- must be named in evidence', () => {
    assert.strictEqual('evidence', 'invisible', 'issue #211 seeded canary: this nested subtest failure must appear in the spec log and junit artifact');
  });
});
