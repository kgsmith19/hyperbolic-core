import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("loadConfig: defaults to port 8300 and broker-policy.json when nothing is set", () => {
  const config = loadConfig({});
  assert.equal(config.port, 8300);
  assert.equal(config.policyPath, "broker-policy.json");
});

test("loadConfig: honors BROKER_PORT and BROKER_POLICY_PATH overrides", () => {
  const config = loadConfig({ BROKER_PORT: "9999", BROKER_POLICY_PATH: "/etc/broker/policy.json" });
  assert.equal(config.port, 9999);
  assert.equal(config.policyPath, "/etc/broker/policy.json");
});

test("loadConfig: rejects a non-numeric BROKER_PORT rather than silently falling back", () => {
  assert.throws(() => loadConfig({ BROKER_PORT: "not-a-port" }), /BROKER_PORT must be a valid port number/);
});

test("loadConfig: rejects a BROKER_PORT outside the valid 1-65535 range", () => {
  assert.throws(() => loadConfig({ BROKER_PORT: "0" }), /BROKER_PORT must be a valid port number/);
  assert.throws(() => loadConfig({ BROKER_PORT: "70000" }), /BROKER_PORT must be a valid port number/);
});
