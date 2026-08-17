#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import { loadPolicy } from "./policy.ts";
import { startServer } from "./server.ts";

const config = loadConfig();
const policy = loadPolicy(config.policyPath);
const server = await startServer(config.port, policy);
const address = server.address();
const port = typeof address === "object" && address ? address.port : config.port;
console.log(`services/broker listening on 127.0.0.1:${port}`);
