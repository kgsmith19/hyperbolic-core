// The NotificationSurface implementation (docs/planning/05-a-hyperbolic-core.md
// section 7, platform contract C-4).
//
// Two transports, exactly as 05-a section 7 specifies them:
//   - within a document: in memory (the `entries` array below);
//   - across zones (LifeOS bundle -> Shell bundle and back):
//     `BroadcastChannel("platform-notifications")` carrying
//     `PlatformNotification` JSON, which works because ADR-02 puts every
//     zone on one origin.
// Persistence: NONE. V1 notifications are session-ephemeral (05-a gate
// question 3, 09 section 4.5's Persistence row) -- nothing here touches
// localStorage/sessionStorage/IndexedDB, and that omission is deliberate,
// not unfinished.

import type {
  NotificationSurface,
  PlatformNotification,
  PublishableNotification,
  Unsubscribe,
} from "./types";

/** 05-a section 7 names this channel exactly; zones agree on the literal. */
export const NOTIFICATION_CHANNEL = "platform-notifications";

/**
 * Wire format. The channel carries `PlatformNotification` JSON per 05-a
 * section 7; `dismiss` needs a second message shape so a dismissal in one
 * zone also clears the other zone's copy (otherwise `list()` would diverge
 * permanently between two documents of the same session, which is a worse
 * contract violation than the extra message type is an addition). Every
 * inbound message is shape-validated before it is trusted -- a same-origin
 * page is not automatically a well-behaved one, and a malformed post must
 * never take down the Shell's chrome.
 */
type ChannelMessage =
  | { kind: "publish"; notification: PlatformNotification }
  | { kind: "dismiss"; id: string };

/** The subset of BroadcastChannel this module uses; keeps it testable. */
export interface NotificationChannel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface NotificationSurfaceOptions {
  /** Defaults to a real BroadcastChannel when the platform has one. */
  createChannel?: () => NotificationChannel | null;
  /** Defaults to crypto.randomUUID (with a non-crypto fallback). */
  createId?: () => string;
  /** Defaults to Date.now, injected so tests can pin `createdAt`. */
  now?: () => number;
  /**
   * NOT part of the 05-a contract -- an explicit, flagged addition. The
   * surface is session-ephemeral but a session is not short, and an
   * unbounded in-memory array fed by the Brain's run-event stream (BR-4)
   * would grow without limit for as long as a tab stays open. Oldest
   * entries beyond this count are dropped. Set generously so it can never
   * be mistaken for the "max 3 visible" presentation rule, which is a
   * different thing entirely (see toast-machine.ts).
   */
  maxEntries?: number;
}

/**
 * The concrete return type of `createNotificationSurface`. It IS a
 * `NotificationSurface` (the four 05-a methods, verbatim) plus one lifecycle
 * method the contract has no opinion about: `close()` releases the
 * BroadcastChannel. Flagged as an addition rather than smuggled in --
 * without it a test process (or a torn-down React root) leaks an open
 * channel, and `getNotificationSurface()` below deliberately hands back the
 * narrow `NotificationSurface` type so ordinary zone code cannot close the
 * document-wide singleton out from under the chrome.
 */
export interface NotificationSurfaceHandle extends NotificationSurface {
  close(): void;
}

function defaultCreateId(): string {
  const c: Crypto | undefined = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for a non-secure context (crypto.randomUUID is unavailable on
  // plain http:// origins other than localhost). Collision-resistant enough
  // for a session-ephemeral, single-operator surface.
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultCreateChannel(): NotificationChannel | null {
  // Node exposes BroadcastChannel too, but there is no browser document to
  // own it during SSR. Opening one there would create a process-wide
  // transport and let separate requests exchange session-ephemeral state.
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (typeof BroadcastChannel === "undefined") return null; // an old runtime
  try {
    const channel = new BroadcastChannel(NOTIFICATION_CHANNEL);
    // Node also implements BroadcastChannel (SSR, and this package's own
    // node --test suite), and there its handle keeps the event loop alive
    // until closed -- a server render of Chrome would otherwise stop the
    // process from exiting. `unref` does not exist in a browser, so this is
    // a no-op in the environment that actually matters.
    const unref = (channel as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(channel);
    return channel as unknown as NotificationChannel;
  } catch {
    return null;
  }
}

const LEVELS = new Set(["info", "success", "warning", "error"]);
const SOURCES = new Set(["shell", "lifeos", "acc", "toolbelt", "brain"]);

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSameOriginPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
  try {
    const parsed = new URL(value, "https://platform.invalid");
    return parsed.origin === "https://platform.invalid" && parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizePublishableNotification(value: unknown): PublishableNotification | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const n = value as Record<string, unknown>;
    if (
      typeof n.level !== "string" ||
      !LEVELS.has(n.level) ||
      typeof n.title !== "string" ||
      n.title.length === 0 ||
      n.title.length > 200 ||
      typeof n.source !== "string" ||
      !SOURCES.has(n.source) ||
      (n.body !== undefined && (typeof n.body !== "string" || n.body.length > 10_000)) ||
      (n.href !== undefined && !isSameOriginPath(n.href))
    ) {
      return null;
    }
    return {
      level: n.level as PublishableNotification["level"],
      title: n.title,
      ...(n.body === undefined ? {} : { body: n.body as string }),
      source: n.source as PublishableNotification["source"],
      ...(n.href === undefined ? {} : { href: n.href as string }),
    };
  } catch {
    return null;
  }
}

function normalizePlatformNotification(value: unknown): PlatformNotification | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const n = value as Record<string, unknown>;
    const publishable = normalizePublishableNotification(n);
    if (!publishable || !isValidId(n.id) || !isCanonicalIsoInstant(n.createdAt)) return null;
    return {
      id: n.id,
      ...publishable,
      createdAt: n.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * Chronological order, oldest first, with the id as the tie-breaker.
 *
 * The tie-break is not cosmetic: two zones can publish inside the same
 * millisecond, and each document receives its own publish before the
 * other's. Ordering purely by `createdAt` would leave the two documents
 * showing the same two notifications in opposite orders. Sorting by
 * (createdAt, id) makes every document converge on one identical order from
 * the same set of entries, whatever order they arrived in.
 */
function compareEntries(a: PlatformNotification, b: PlatformNotification): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Creates a notification surface. One per document is the intended shape --
 * see `getNotificationSurface()`, which is what zone code should normally
 * use; this factory exists for tests and for a zone that genuinely needs an
 * isolated surface.
 */
export function createNotificationSurface(
  options: NotificationSurfaceOptions = {}
): NotificationSurfaceHandle {
  const createId = options.createId ?? defaultCreateId;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 100;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
    throw new RangeError("notification maxEntries must be an integer between 1 and 10000");
  }
  const channel = (options.createChannel ?? defaultCreateChannel)();

  let entries: PlatformNotification[] = [];
  let lastStampMs = 0;
  const handlers = new Set<(all: PlatformNotification[]) => void>();

  /**
   * A strictly increasing `createdAt`, per surface.
   *
   * Found by test, not by inspection: `Date.now()` has millisecond
   * resolution, so two publishes in the same tick share a timestamp, and
   * ordering then fell through to the (random UUID) id tie-break -- which
   * silently reordered two notifications published back to back in ONE
   * document. Nudging a colliding stamp forward by 1ms keeps local publish
   * order exact while leaving the (createdAt, id) sort -- and therefore
   * cross-document convergence, see compareEntries -- intact. The cost is
   * that a burst of N notifications can carry timestamps up to N-1 ms later
   * than the instant they were published, which is invisible at any
   * granularity this surface displays.
   */
  function nextCreatedAt(): string {
    const at = Math.max(now(), lastStampMs + 1);
    lastStampMs = at;
    return new Date(at).toISOString();
  }

  function emit(): void {
    // Every handler gets its own array copy: a subscriber that sorts or
    // splices the value it was handed must not be able to corrupt the
    // surface's own state, or another subscriber's view of it.
    for (const handler of [...handlers]) {
      try {
        handler(entries.slice());
      } catch {
        // A zone owns its subscriber, not the platform bus. Isolate a bad
        // consumer so it cannot block later subscribers or cross-zone
        // delivery of a notification that was already accepted.
      }
    }
  }

  /** Inserts in (createdAt, id) order; ignores an id already present. */
  function insert(notification: PlatformNotification): boolean {
    if (entries.some((entry) => entry.id === notification.id)) return false;
    const next = entries.slice();
    let index = next.length;
    while (index > 0 && compareEntries(next[index - 1], notification) > 0) index--;
    next.splice(index, 0, notification);
    entries = next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
    return true;
  }

  function remove(id: string): boolean {
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    entries = next;
    return true;
  }

  if (channel) {
    channel.onmessage = (event: { data: unknown }) => {
      const message = event.data as ChannelMessage | undefined;
      if (typeof message !== "object" || message === null) return;
      if (message.kind === "publish") {
        const notification = normalizePlatformNotification(message.notification);
        if (!notification) return;
        // No re-broadcast: applying a remote message locally must not post
        // it back out, or two documents would ping-pong one notification
        // forever. (A browser BroadcastChannel never echoes to the sender,
        // so the loop would be A -> B -> A -> B ..., not a self-loop.)
        if (insert(notification)) emit();
      } else if (message.kind === "dismiss" && isValidId(message.id)) {
        if (remove(message.id)) emit();
      }
    };
  }

  function post(message: ChannelMessage): void {
    if (!channel) return;
    try {
      channel.postMessage(message);
    } catch {
      // A closed channel or a structured-clone failure must never break the
      // local publish that just succeeded: cross-zone delivery is
      // best-effort, the in-document surface is not.
    }
  }

  const surface: NotificationSurfaceHandle = {
    publish(n: PublishableNotification): string {
      const publishable = normalizePublishableNotification(n);
      if (!publishable) {
        throw new TypeError("invalid platform notification");
      }
      const id = createId();
      if (!isValidId(id)) {
        throw new TypeError("notification id must be a non-empty string no longer than 200 characters");
      }
      const notification: PlatformNotification = {
        id,
        ...publishable,
        createdAt: nextCreatedAt(),
      };
      if (!insert(notification)) throw new Error(`duplicate notification id: ${id}`);
      emit();
      post({ kind: "publish", notification });
      return notification.id;
    },

    dismiss(id: string): void {
      if (typeof id !== "string" || id.length === 0 || id.length > 200) return;
      // Broadcast unconditionally, even when this document holds no such
      // entry: the notification may only exist in the other zone's copy
      // (e.g. this document was opened after it was published).
      const changed = remove(id);
      if (changed) emit();
      post({ kind: "dismiss", id });
    },

    list(): PlatformNotification[] {
      return entries.slice();
    },

    subscribe(handler: (all: PlatformNotification[]) => void): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    close(): void {
      handlers.clear();
      if (channel) {
        channel.onmessage = null;
        channel.close();
      }
    },
  };

  return surface;
}

let documentSurface: NotificationSurfaceHandle | null = null;

/**
 * The one surface per document (contract C-4: "publish only through
 * NotificationSurface ... no zone renders its own toast stack for
 * platform-level events"). Created lazily on first use so merely importing
 * @hyperbolic/ui never opens a BroadcastChannel -- including during SSR,
 * where there is no BroadcastChannel to open.
 */
export function getNotificationSurface(): NotificationSurface {
  // There is no document-scoped owner during SSR. A module singleton here
  // would leak one request's ephemeral notification state into another.
  if (typeof document === "undefined") {
    return createNotificationSurface({ createChannel: () => null });
  }
  if (!documentSurface) documentSurface = createNotificationSurface();
  return documentSurface;
}
