// Shared helpers for the Brain's suites. Not named *.test.ts on purpose: the
// package's test script globs tests/*.test.ts, so this file is a module the
// suites import, never a suite of its own.
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { Run, Task } from "../src/types.ts";

// ------------------------------------------------------------------ JWT

/** base64url per RFC 7515: base64 with the URL-safe alphabet and no padding. */
export function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type PrivateKey = ReturnType<typeof generateKeyPairSync>["privateKey"];

/** A throwaway P-256 keypair. The public half comes back as SPKI PEM because
 *  that is the form the verifier is configured with. */
export function generateEcKeyPair(): { publicKeyPem: string; privateKey: PrivateKey } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
}

/** Sign an arbitrary header/payload pair as a compact ES256 JWT.
 *
 *  `dsaEncoding: "ieee-p1363"` is load-bearing: node defaults to DER, but JWS
 *  requires the fixed-width r||s form, and a DER signature verifies as a
 *  malformed token rather than an invalid one -- which would make a test
 *  asserting rejection pass for the wrong reason. */
export function signJwt(privateKey: PrivateKey, header: object, payload: object): string {
  const headerB64 = base64Url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64Url(Buffer.from(JSON.stringify(payload)));
  const signature = cryptoSign("SHA256", Buffer.from(`${headerB64}.${payloadB64}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${headerB64}.${payloadB64}.${base64Url(signature)}`;
}

// -------------------------------------------------------------- fixtures

/** A running Run, overridable field by field. */
export function fixtureRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return { id: "run-1", objective: "x", autonomy: 2, status: "running", createdAt: now, updatedAt: now, ...overrides };
}

/** A pending Task belonging to fixtureRun()'s run, overridable field by field. */
export function fixtureTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "t1",
    runId: "run-1",
    title: "x",
    status: "pending",
    contractJson: "{}",
    resultJson: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}
