import http from "node:http";
import https from "node:https";

function normalizedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined) return [];
      return [[name, Array.isArray(value) ? value.join(", ") : value]];
    }),
  );
}

export function rawHttpRequest(
  origin,
  requestTarget,
  { maxBodyBytes = 1024 * 1024, timeoutMs = 5_000 } = {},
) {
  const base = new URL(origin);
  if (base.pathname !== "/" || base.search || base.hash) {
    throw new Error(
      "raw HTTP request origin must not include a path, query, or fragment",
    );
  }
  if (!requestTarget.startsWith("/") || /[\r\n]/.test(requestTarget)) {
    throw new Error(
      "raw HTTP request target must be an absolute path without CR/LF",
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("raw HTTP request timeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("raw HTTP request maxBodyBytes must be a positive integer");
  }

  const transport =
    base.protocol === "http:"
      ? http
      : base.protocol === "https:"
        ? https
        : null;
  if (!transport) {
    throw new Error(`unsupported raw HTTP protocol: ${base.protocol}`);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => settle(reject, error);

    const request = transport.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || undefined,
        method: "GET",
        path: requestTarget,
        headers: { connection: "close" },
        agent: false,
      },
      (response) => {
        const chunks = [];
        let bodyBytes = 0;
        response.on("data", (chunk) => {
          bodyBytes += chunk.length;
          if (bodyBytes > maxBodyBytes) {
            response.destroy(
              new Error(`raw HTTP response exceeded ${maxBodyBytes} bytes`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", fail);
        response.once("end", () => {
          settle(resolve, {
            status: response.statusCode ?? 0,
            headers: normalizedHeaders(response.headers),
            body: Buffer.concat(chunks).toString("utf8"),
            rawRequestTarget: request.path,
          });
        });
      },
    );
    request.once("error", fail);
    timer = setTimeout(() => {
      request.destroy(
        new Error(`raw HTTP request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    request.end();
  });
}
