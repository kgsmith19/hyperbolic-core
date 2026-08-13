#!/usr/bin/env node
import { loadConfig, requiredServiceRoleKey } from "./config.ts";
import { startServer } from "./server.ts";

const config = loadConfig();
const serviceRoleKey = requiredServiceRoleKey();
const server = await startServer(config, serviceRoleKey);
const address = server.address();
const port = typeof address === "object" && address ? address.port : config.port;
console.log(`services/llm-handler listening on 127.0.0.1:${port}`);
