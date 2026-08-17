// The broker's log-only pass-through path (issue #185): every well-formed
// request is logged with caller, target host, and timestamp, then forwarded
// to its target unmodified -- no allow/deny decision yet. isKnownCaller is
// looked up and included in the log entry for future denial visibility
// (issue #187), but an unknown caller is proxied exactly like a known one at
// this phase; only #187's soak-then-approve enforcement flip may change that.
//
// Never throws: a malformed request body (missing fields, wrong types, even
// a function or array where an object was expected) is answered with a 400
// and never reaches the caller as an uncaught exception -- mirrors
// @hyperbolic/broker-contract's own "never throws" convention for untrusted
// input (contract.mjs's validateRequest normalizes before any property
// access, closing the exact Function.caller poison-pill class of bug the
// contract module itself was hardened against).

import * as http from "node:http";
import * as https from "node:https";
import { validateRequest } from "@hyperbolic/broker-contract";
import { isKnownCaller, type PolicyDocument } from "./policy.ts";

export interface ProxyRequestBody {
  caller: string;
  token: string;
  targetHost: string;
  protocol?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ProxyLogEntry {
  caller: string;
  targetHost: string;
  knownCaller: boolean;
  timestamp: string;
}

export type LogFn = (entry: ProxyLogEntry) => void;

export function defaultLog(entry: ProxyLogEntry): void {
  console.log(JSON.stringify({ event: "broker_proxy_request", ...entry }));
}

// Same normalization contract.mjs's own validateRequest applies before any
// property access: typeof === "object" && !Array.isArray, so a function,
// array, string, or null input is treated as an empty object rather than
// crashing on property lookup.
function normalize(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function proxyRequest(input: unknown, policy: PolicyDocument, log: LogFn = defaultLog): Promise<ProxyResult> {
  const candidate = normalize(input);
  const validation = validateRequest(candidate);
  if (!validation.ok) {
    return {
      status: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "invalid broker request", details: validation.errors }),
    };
  }

  const request = candidate as unknown as ProxyRequestBody;
  const knownCaller = isKnownCaller(request.caller, policy);
  log({ caller: request.caller, targetHost: request.targetHost, knownCaller, timestamp: new Date().toISOString() });

  return forward(request);
}

function forward(request: ProxyRequestBody): Promise<ProxyResult> {
  const transport = request.protocol === "http" ? http : https;
  const [host, portStr] = request.targetHost.split(":");
  const port = portStr ? Number(portStr) : undefined;

  return new Promise((resolve) => {
    const upstreamReq = transport.request(
      {
        host,
        port,
        path: request.path ?? "/",
        method: request.method ?? "GET",
        headers: request.headers,
      },
      (upstreamRes) => {
        let data = "";
        upstreamRes.on("data", (chunk: Buffer) => {
          data += chunk;
        });
        upstreamRes.on("end", () => {
          const contentType = upstreamRes.headers["content-type"];
          resolve({
            status: upstreamRes.statusCode ?? 502,
            headers: contentType ? { "content-type": contentType } : {},
            body: data,
          });
        });
      },
    );
    // A dead/unreachable target must answer the broker's own caller, not
    // crash the process -- the broker itself is not the thing being tested
    // for reachability here.
    upstreamReq.on("error", (err) => {
      resolve({
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "broker upstream request failed", message: (err as Error).message }),
      });
    });
    if (request.body) upstreamReq.write(request.body);
    upstreamReq.end();
  });
}
