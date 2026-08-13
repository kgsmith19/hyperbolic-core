/**
 * Retry-After header parsing (finding #86), shared by the Anthropic and
 * OpenAI drivers -- both previously carried an IDENTICAL copy-pasted
 * numeric-only parser. (Gemini's classifyGeminiError never reads
 * Retry-After: the installed SDK's ApiError type carries only
 * `{status, message}`, no headers to read one from.)
 *
 * Per RFC 7231 section 7.1.3, Retry-After is EITHER an integer number of
 * delta-seconds OR an HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT"). The
 * pre-hoist implementation only ever handled the delta-seconds form
 * (`Number(raw)`) -- a real HTTP-date value made `Number(raw)` evaluate to
 * NaN and silently fall back to the computed backoff instead of honoring
 * the provider's actual requested wait.
 */
export function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    // Delta-seconds form -- existing behavior, unchanged. A negative value
    // is malformed input (RFC 7231 defines this as a non-negative integer),
    // not a meaningful "retry in the past" signal, so it is discarded
    // (falls back to the computed backoff) exactly as before this hoist.
    return seconds >= 0 ? seconds * 1000 : undefined;
  }

  // Not delta-seconds (Number() on a genuine HTTP-date string is NaN) --
  // try the HTTP-date form.
  const parsedMs = Date.parse(raw);
  if (Number.isNaN(parsedMs)) {
    return undefined; // garbage/unparseable in either form: computed backoff
  }
  const deltaMs = parsedMs - Date.now();
  // Unlike a negative delta-seconds value (simply malformed), an HTTP-date
  // already in the past is syntactically valid and means "you may retry
  // now" (or reflects ordinary clock skew) -- a real, meaningful signal, so
  // it is bounded to 0 rather than discarded to undefined.
  //
  // Deliberately NOT capped at this package's own RETRY_CAP_MS (retry.ts):
  // retry.test.ts's own "honors retryAfterMs verbatim... even above the 30s
  // cap" test already pins down that an explicit provider-requested wait,
  // however it arrives, is honored verbatim rather than clamped to the
  // computed-backoff cap -- capping only the HTTP-date form here would make
  // an identical requested wait behave differently depending purely on
  // which of the two RFC 7231 formats the provider happened to use.
  return Math.max(0, deltaMs);
}
