#!/usr/bin/env node
import { loadBudgetConfig } from "./budget.ts";
import { loadCallerTokens } from "./caller-tokens.ts";
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
// Same dark-until-provisioned convention: a caller with no
// BROKER_CALLER_TOKEN_<CALLER> configured yet simply cannot pass
// authorizeCredential's token check (403) until the owner provisions it.
const callerTokens = loadCallerTokens(process.env, Object.keys(policy));
// Same dark-until-provisioned convention (issue #200): a request naming
// estimatedCostUsd simply skips the spend-check entirely until the owner
// provisions SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
const budget = loadBudgetConfig(process.env);
const server = await startServer(config.port, policy, { credentials, callerTokens, budget });
const address = server.address();
const port = typeof address === "object" && address ? address.port : config.port;
console.log(`services/broker listening on 127.0.0.1:${port}`);
