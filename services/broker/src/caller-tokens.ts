// Authenticates WHO is asking, not just what a request claims (issue #186
// round-2 independent review's finding): before this file existed, every
// ProxyRequestBody.token was shape-checked as a non-empty string by
// contract.mjs's validateRequest and never verified against anything --
// any local process could name `caller: "llm-handler"` and receive
// llm-handler's own credentials. Scoped deliberately narrow: this only
// gates the CREDENTIAL-injection path (proxy.ts's authorizeCredential),
// not the general log-only pass-through, which is issue #187's own
// soak-then-approve territory -- a different mechanism for a different
// risk (host allowlisting vs. secret disclosure).
//
// Dark-until-provisioned, same convention as credentials.ts: a caller with
// no token configured simply cannot pass authentication yet (refused,
// never crashes broker startup).

import { timingSafeEqual } from "node:crypto";

export type CallerTokenMap = Record<string, string>;

function envVarNameFor(caller: string): string {
  return `BROKER_CALLER_TOKEN_${caller.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function loadCallerTokens(env: NodeJS.ProcessEnv, callerIds: Iterable<string>): CallerTokenMap {
  const tokens: CallerTokenMap = {};
  for (const caller of callerIds) {
    const envVar = envVarNameFor(caller);
    if (!Object.prototype.hasOwnProperty.call(env, envVar)) continue;
    const value = env[envVar];
    if (typeof value === "string" && value.length > 0) tokens[caller] = value;
  }
  return tokens;
}

// Constant-time comparison: a caller-supplied token must never be
// distinguishable from the real one (or from "this caller has no token
// provisioned at all") by response-timing side channel. The equal-length
// self-comparison on a length mismatch keeps the function's total work
// close to constant regardless of which branch is taken, rather than
// short-circuiting on `expected.length !== supplied.length` alone.
export function verifyCallerToken(tokens: CallerTokenMap, caller: string, suppliedToken: string): boolean {
  const expected = tokens[caller];
  if (expected === undefined) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const suppliedBuf = Buffer.from(suppliedToken, "utf8");
  if (expectedBuf.length !== suppliedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(expectedBuf, suppliedBuf);
}
