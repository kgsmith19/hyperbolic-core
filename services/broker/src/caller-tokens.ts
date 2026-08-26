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

// Naming asymmetry, deliberate (issue #187 Phase 0): the broker reads each
// caller's token as the SUFFIXED `BROKER_CALLER_TOKEN_<CALLER>` from its own
// environment (Infisical `/platform/broker/`), while the caller itself reads
// the same secret VALUE as the unsuffixed `BROKER_CALLER_TOKEN` from ITS
// environment (e.g. `/platform/llm-handler/` -- see
// services/llm-handler/src/broker-drivers.ts's loadBrokerDriverConfig).
// ADR-05 gives the two identities no shared secret path, so the one value is
// provisioned twice, once under each path, under those two names.
function envVarNameFor(caller: string): string {
  return `BROKER_CALLER_TOKEN_${caller.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function loadCallerTokens(env: NodeJS.ProcessEnv, callerIds: Iterable<string>): CallerTokenMap {
  const tokens: CallerTokenMap = {};
  const envVarsSeen = new Map<string, string>();
  for (const caller of callerIds) {
    const envVar = envVarNameFor(caller);
    // Round-2 independent review's finding (NEW-5): two distinct caller ids
    // can normalize to the identical env var name (e.g. "llm-handler" and
    // "llm_handler" both -> BROKER_CALLER_TOKEN_LLM_HANDLER). No collision
    // exists among today's real caller ids, but a silent one would let a
    // future manifest's caller authenticate as a DIFFERENT caller entirely
    // -- fail loud at load time instead, the same "never silently wrong"
    // posture credentials.ts's own defense-in-depth already takes.
    const previousCaller = envVarsSeen.get(envVar);
    if (previousCaller !== undefined) {
      throw new Error(
        `services/broker: caller ids "${previousCaller}" and "${caller}" both normalize to the same token env var "${envVar}" -- cannot provision distinct tokens for them`,
      );
    }
    envVarsSeen.set(envVar, caller);
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
//
// hasOwnProperty-guarded (round-2 independent review's finding, NEW-1 --
// the same defect class as credentials.ts's own S6 fix, one file over): a
// bare `tokens[caller]` reads through the prototype chain, so
// `caller: "constructor"` resolved to a function, which then reached
// Buffer.from(<function>) and threw a raw, unclassified TypeError out of
// proxyRequest entirely -- both leaking Node's own internal error text
// (this module's stated "never throws" contract) and skipping the audit
// log entirely, since the throw happened before proxyRequest's log() call.
export function verifyCallerToken(tokens: CallerTokenMap, caller: string, suppliedToken: string): boolean {
  const expected = Object.prototype.hasOwnProperty.call(tokens, caller) ? tokens[caller] : undefined;
  if (expected === undefined) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const suppliedBuf = Buffer.from(suppliedToken, "utf8");
  if (expectedBuf.length !== suppliedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(expectedBuf, suppliedBuf);
}
