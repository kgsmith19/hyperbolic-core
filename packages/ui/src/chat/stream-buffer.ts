// Per-frame token coalescing (docs/planning/09-design-system.md section 6:
// "stream events append into the active message; DOM writes are coalesced
// to at most one flush per animation frame regardless of event arrival
// rate"). Pure accumulation/flush logic here; the rAF scheduling loop that
// calls it lives in the `useCoalescedStream` hook below, the one piece of
// this module that touches `requestAnimationFrame` and so cannot run under
// plain `node:test` -- kept to the minimum: schedule one callback, flush,
// repeat.

import * as React from "react";

export interface TokenBufferState {
  readonly pending: ReadonlyMap<string, string>;
}

export function createTokenBuffer(): TokenBufferState {
  return { pending: new Map() };
}

/** Appends `text` to `messageId`'s pending (not-yet-flushed) buffer. */
export function appendToken(state: TokenBufferState, messageId: string, text: string): TokenBufferState {
  const next = new Map(state.pending);
  next.set(messageId, (next.get(messageId) ?? "") + text);
  return { pending: next };
}

export interface FlushResult {
  /** The buffer after flushing -- empty when anything was pending, unchanged (same reference) otherwise. */
  readonly state: TokenBufferState;
  /** messageId -> text accumulated since the last flush. Empty when nothing was pending. */
  readonly updates: ReadonlyMap<string, string>;
}

/** A no-op flush (empty `updates`, same `state` reference) when nothing is pending -- callers can flush unconditionally every frame without a manual "is there anything to do" check. */
export function flushTokenBuffer(state: TokenBufferState): FlushResult {
  if (state.pending.size === 0) return { state, updates: state.pending };
  return { state: createTokenBuffer(), updates: state.pending };
}

export interface CoalescedStreamHandle {
  /** Buffers `text` for `messageId`; the next animation frame flushes it (and anything else pending) in one batch. */
  append(messageId: string, text: string): void;
}

/**
 * `onFlush` receives every message's accumulated text for one animation
 * frame in a single call -- never once per token. Scheduling stops (no
 * dangling rAF) once the calling component unmounts.
 */
export function useCoalescedStream(onFlush: (updates: ReadonlyMap<string, string>) => void): CoalescedStreamHandle {
  const bufferRef = React.useRef(createTokenBuffer());
  const frameRef = React.useRef<number | null>(null);
  const onFlushRef = React.useRef(onFlush);
  onFlushRef.current = onFlush;

  React.useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  const scheduleFlush = React.useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const { state, updates } = flushTokenBuffer(bufferRef.current);
      bufferRef.current = state;
      if (updates.size > 0) onFlushRef.current(updates);
    });
  }, []);

  return React.useMemo(
    () => ({
      append(messageId: string, text: string) {
        bufferRef.current = appendToken(bufferRef.current, messageId, text);
        scheduleFlush();
      },
    }),
    [scheduleFlush]
  );
}
