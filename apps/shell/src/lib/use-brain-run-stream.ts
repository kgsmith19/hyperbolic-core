// The SSE consumption hook for the Brain run surface (m4-16). Built
// directly on `fetch` + platform-client's exported `SseLineParser` rather
// than BrainClient.streamRunEvents: that helper's single-call shape (fetch
// + fully consume, one Promise for the whole connection lifetime) has no
// seam to signal "connected" separately from "an event arrived", and this
// hook needs that seam to drive the status strip's live/reconnecting/
// offline states (09 section 7.3) accurately -- a still-open, heartbeat-only
// connection with no new journal events yet is `live`, not `reconnecting`.
import * as React from "react";
import { SseLineParser, type BrainEvent, type BrainRun, type BrainTask } from "@hyperbolic/platform-client";
import { getNotificationSurface } from "@hyperbolic/ui";
import { platformClient, brainClient, BRAIN_BASE_URL } from "./session";
import {
  applyBrainEvent,
  applyLocalApprovalResolution,
  computeConnectionDisplayState,
  initialBrainRunState,
  reconnectDelayMs,
  taskTitleLookup,
  type BrainConnectionState,
  type BrainRunReducerState,
} from "./brain-run";

export interface UseBrainRunStreamResult {
  transcript: BrainRunReducerState;
  run: BrainRun | undefined;
  tasks: readonly BrainTask[];
  connectionState: BrainConnectionState;
  reconnectAttempt: number;
  approve: (taskId: string) => Promise<void>;
  reject: (taskId: string, reason?: string) => Promise<void>;
}

const RUN_POLL_MS = 5_000;

export function useBrainRunStream(runId: string | null): UseBrainRunStreamResult {
  const [transcript, setTranscript] = React.useState<BrainRunReducerState>(initialBrainRunState);
  const [run, setRun] = React.useState<BrainRun | undefined>(undefined);
  const [tasks, setTasks] = React.useState<readonly BrainTask[]>([]);
  const [rawConnection, setRawConnection] = React.useState<"live" | "reconnecting">("reconnecting");
  const [disconnectedAtMs, setDisconnectedAtMs] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const [reconnectAttempt, setReconnectAttempt] = React.useState(0);

  const lastEventIdRef = React.useRef<number | undefined>(undefined);
  const taskTitleRef = React.useRef<(taskId: string) => string | undefined>(() => undefined);
  taskTitleRef.current = React.useMemo(() => taskTitleLookup(tasks), [tasks]);
  const knownApprovalTaskIdsRef = React.useRef<Set<string>>(new Set());

  // Reset all per-run state the instant the operator selects a different
  // run -- otherwise the previous run's transcript would flash before the
  // new run's replay lands.
  React.useEffect(() => {
    setTranscript(initialBrainRunState());
    setRun(undefined);
    setTasks([]);
    setRawConnection("reconnecting");
    setDisconnectedAtMs(null);
    setReconnectAttempt(0);
    lastEventIdRef.current = undefined;
    knownApprovalTaskIdsRef.current = new Set();
  }, [runId]);

  // Ticks `now` once a second while not live, so computeConnectionDisplayState
  // can escalate reconnecting -> offline at the 10s mark without depending
  // on another event to trigger a re-render.
  React.useEffect(() => {
    if (rawConnection === "live") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [rawConnection]);

  const connectionState = computeConnectionDisplayState(rawConnection, disconnectedAtMs, now);

  // BR-4 (03-v1-definition.md): resumes from the store with no lost state
  // on reconnect -- `run.status`/task rows are the durable source of truth
  // the journal's coarse events don't fully cover (no run-state-transition
  // event kind exists yet), so this poll is how the surface stays accurate
  // across a reconnect gap, independent of the SSE replay itself.
  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const result = await brainClient.getRun(runId!);
        if (cancelled || !result) return;
        setRun(result.run);
        setTasks(result.tasks);
      } catch {
        // A transient poll failure is not a connection-state signal on its
        // own -- the SSE loop below owns live/reconnecting/offline.
      }
    }

    void poll();
    const id = setInterval(poll, RUN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId]);

  // The SSE connection itself: fetch + manual SseLineParser loop, with
  // Last-Event-ID resume and exponential-backoff reconnect.
  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let attempt = 0;
    let controller: AbortController | null = null;

    async function connectOnce(): Promise<void> {
      controller = new AbortController();
      try {
        const session = await platformClient.auth.getSession();
        if (!session) throw new Error("brain-run-stream: no active session");

        const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` };
        if (lastEventIdRef.current !== undefined) headers["last-event-id"] = String(lastEventIdRef.current);

        const res = await fetch(`${BRAIN_BASE_URL}/api/brain/runs/${encodeURIComponent(runId!)}/events`, {
          headers,
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok || !res.body) throw new Error(`brain-run-stream: connect failed with ${res.status}`);

        // Connected: flip live BEFORE the first event, so a heartbeat-only
        // quiet period still reads as live, not stuck reconnecting.
        attempt = 0;
        setReconnectAttempt(0);
        setDisconnectedAtMs(null);
        setRawConnection("live");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseLineParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (cancelled) {
            await reader.cancel().catch(() => {});
            return;
          }
          for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
            if (!evt.data) continue;
            if (evt.id !== null) lastEventIdRef.current = evt.id;
            let parsed: BrainEvent;
            try {
              parsed = JSON.parse(evt.data) as BrainEvent;
            } catch {
              continue; // a malformed data line is a producer bug, not fatal to the rest of the stream
            }
            setTranscript((state) => applyBrainEvent(state, parsed, evt.id, taskTitleRef.current));
            if (parsed.kind === "task.parked_for_approval") {
              const taskId = typeof parsed.taskId === "string" ? parsed.taskId : undefined;
              // Publish once per task, not once per (possible) duplicate
              // delivery on a replayed reconnect -- 09 section 7.4:
              // "a notification publishes through the 05-a surface".
              if (taskId && !knownApprovalTaskIdsRef.current.has(taskId)) {
                knownApprovalTaskIdsRef.current.add(taskId);
                getNotificationSurface().publish({
                  level: "warning",
                  title: "Approval requested",
                  body: taskTitleRef.current(taskId) ?? `Task ${taskId} is awaiting approval`,
                  source: "brain",
                  href: `/acc/brain?run=${encodeURIComponent(runId!)}`,
                });
              }
            }
          }
        }
        // The server closed the stream cleanly -- still a disconnect from
        // this client's point of view, so reconnect the same as an error.
        throw new Error("brain-run-stream: stream ended");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return; // intentional teardown, not a real disconnect
        setRawConnection("reconnecting");
        setDisconnectedAtMs((prev) => prev ?? Date.now());
        attempt += 1;
        setReconnectAttempt(attempt);
        const delay = reconnectDelayMs(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!cancelled) await connectOnce();
      }
    }

    void connectOnce();
    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [runId]);

  const approve = React.useCallback(async (taskId: string) => {
    await brainClient.approveTask(taskId);
    setTranscript((state) => applyLocalApprovalResolution(state, taskId, "approved"));
  }, []);

  const reject = React.useCallback(async (taskId: string, reason?: string) => {
    await brainClient.rejectTask(taskId, reason);
    setTranscript((state) => applyLocalApprovalResolution(state, taskId, "rejected"));
  }, []);

  return { transcript, run, tasks, connectionState, reconnectAttempt, approve, reject };
}
