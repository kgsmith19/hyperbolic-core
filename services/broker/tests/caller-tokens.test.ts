import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCallerTokens, verifyCallerToken } from "../src/caller-tokens.ts";

test("loadCallerTokens: reads BROKER_CALLER_TOKEN_<CALLER> for each known caller id, uppercased and non-alnum replaced with underscore", () => {
  const tokens = loadCallerTokens(
    { BROKER_CALLER_TOKEN_LLM_HANDLER: "secret-1", BROKER_CALLER_TOKEN_BRAIN: "secret-2" },
    ["llm-handler", "brain"],
  );
  assert.deepEqual(tokens, { "llm-handler": "secret-1", brain: "secret-2" });
});

test("loadCallerTokens: a caller with no matching env var is simply absent from the map, not an empty string or a thrown error -- dark until provisioned", () => {
  const tokens = loadCallerTokens({ BROKER_CALLER_TOKEN_LLM_HANDLER: "secret-1" }, ["llm-handler", "brain"]);
  assert.deepEqual(tokens, { "llm-handler": "secret-1" });
  assert.equal(Object.prototype.hasOwnProperty.call(tokens, "brain"), false);
});

test("loadCallerTokens: never resolves an inherited Object.prototype value for a caller id shaped like a prototype property name", () => {
  const tokens = loadCallerTokens({}, ["constructor"]);
  assert.deepEqual(tokens, {});
});

test("verifyCallerToken: true only for the exact provisioned token for that exact caller", () => {
  const tokens = { "llm-handler": "the-real-token" };
  assert.equal(verifyCallerToken(tokens, "llm-handler", "the-real-token"), true);
  assert.equal(verifyCallerToken(tokens, "llm-handler", "the-wrong-token"), false);
  assert.equal(verifyCallerToken(tokens, "llm-handler", ""), false);
});

test("verifyCallerToken: false for a caller with no token provisioned at all, regardless of what is supplied", () => {
  assert.equal(verifyCallerToken({}, "llm-handler", "anything"), false);
  assert.equal(verifyCallerToken({}, "llm-handler", ""), false);
});

test("verifyCallerToken: a supplied token of a different length than the real one is refused without throwing (timingSafeEqual's own length restriction never leaks as a crash)", () => {
  const tokens = { "llm-handler": "short" };
  assert.equal(verifyCallerToken(tokens, "llm-handler", "a-much-longer-supplied-token-value"), false);
  assert.equal(verifyCallerToken(tokens, "llm-handler", ""), false);
});

test("verifyCallerToken: a token correct for one caller does not authenticate a different caller", () => {
  const tokens = { "llm-handler": "the-real-token", brain: "a-different-token" };
  assert.equal(verifyCallerToken(tokens, "brain", "the-real-token"), false);
});
