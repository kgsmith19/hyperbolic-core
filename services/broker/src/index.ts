#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import { loadCredentials } from "./credentials.ts";
import { loadPolicy } from "./policy.ts";
import { startServer } from "./server.ts";

const config = loadConfig();
const policy = loadPolicy(config.policyPath);
// Dark-until-provisioned (issue #186, matching services/llm-handler's own
// LLM_KEYS_* precedent): a vault key with no value yet in process.env is
// simply absent from the map, not a boot-time failure -- the broker starts
// fine, and only a request that actually names that credential is refused
// (502) until the owner provisions it via Infisical /platform/broker/.
const credentials = loadCredentials(process.env, policy);
const server = await startServer(config.port, policy, { credentials });
const address = server.address();
const port = typeof address === "object" && address ? address.port : config.port;
console.log(`services/broker listening on 127.0.0.1:${port}`);
