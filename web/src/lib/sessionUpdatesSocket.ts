// Modified for Triune; inherited notices remain applicable.
// Persistent WebSocket client for `WS /v1/sessions/updates`.
//
// Replaces the sidebar's 4 s HTTP poll of `GET /v1/sessions` with a single
// long-lived connection: the client tells the server which session ids it's
// displaying (the "watch-set"), and the server pushes a snapshot followed by
// diffs whenever those sessions change. See the server endpoint docstring in
// `omnigent/server/routes/sessions.py` for the wire protocol.
//
// This module owns only the transport (connect, reconnect, send watch-set,
// dispatch frames). SessionUpdatesProvider wires the parsed frames into the
// TanStack Query cache and derives the watch-set from it.
//
// Identity rides the transport exactly like the terminal-attach WebSocket:
// the browser cannot set `X-Forwarded-Email` on a WebSocket handshake, so we
// rely on the ingress / dev proxy to carry the authenticated identity. The
// id list is NEVER trusted from the client for authorization — the server
// access-checks every watched id against the connection's user.

import { isHostRoutingEnabled, resolveWebSocketUrl } from "@/lib/host";
import { modalHostId, isModalHostResolved } from "@/lib/sessionHost";
import type { SessionListWireItem } from "@/lib/sessionListCache";
import { parseEvent } from "./sse";
import { transcriptEventStream } from "./transcriptEventStream";
import type { StreamEvent } from "./events";

/** A frame pushed by the server over the updates stream. */
export type SessionUpdatesFrame =
  | { type: "snapshot"; items: SessionListWireItem[] }
  | { type: "changed"; items: SessionListWireItem[] }
  | { type: "removed"; ids: string[] }
  | { type: "hosts_changed" }
  | { type: "projects_changed" }
  | { type: "heartbeat" }
  | {
      type: "capabilities";
      transcript_stream?: number;
      transcript_window?: number;
      transcript_feed?: number;
      transcript_feed_default?: number;
      transcript_memberships?: number;
    };

export interface TranscriptCursor {
  after_position: number;
  after_revision?: number;
  stream_epoch?: string;
  window_start_position?: number;
}

export const TRANSCRIPT_NEGOTIATION_MS = 750;

export function isRetryableTranscriptError(code: string): boolean {
  return [
    "subscription_limit",
    "stream_overflow",
    "stream_reconnect",
    "stream_failed",
    "runner_unavailable",
    "replica_unavailable",
  ].includes(code);
}

export interface TranscriptResponse {
  ok: true;
  status: 200;
  headers: Headers;
  body: ReadableStream<StreamEvent>;
}
type TranscriptSubscription = ReturnType<typeof transcriptEventStream> & {
  subscriptionId?: string;
  received?: (event: StreamEvent) => void;
};

type FrameListener = (frame: SessionUpdatesFrame) => void;

// Reconnect backoff — mirrors the chat stream pump (chatStore.ts): 250 ms
// base, doubling, capped at 5 s, with ±50% jitter so many tabs reconnecting
// after a server blip don't synchronize into a thundering herd.
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;

// The server pushes a heartbeat every 30 s when a watch-set is idle (see
// `_SESSION_UPDATES_HEARTBEAT_INTERVAL_S`). If we go appreciably longer than
// that with no frame of any kind, the connection is silently dead — a
// half-open TCP socket or an idle-reaping proxy that never sent a close. The
// browser's `onclose` may not fire for a long time in that case, which would
// strand the sidebar (push is dead, and the HTTP fallback poll stays suspended
// because we still believe we're connected). This watchdog forces a reconnect
// so liveness is restored. Set to a little over 2× the heartbeat so a single
// late/dropped heartbeat doesn't churn the connection, but two missed in a row
// do. Exported so the watchdog test can advance fake timers to the exact
// threshold rather than hard-coding the literal.
export const HEARTBEAT_WATCHDOG_MS = 70_000;

function nextReconnectDelay(failedAttempts: number): number {
  const base = Math.min(RECONNECT_BASE_MS * 2 ** (failedAttempts - 1), RECONNECT_MAX_MS);
  return base / 2 + Math.random() * (base / 2);
}

/**
 * Build the `ws(s)://` URL for the session-updates endpoint.
 *
 * Delegates to the host seam (`resolveWebSocketUrl`), exactly like the
 * terminal-attach socket: standalone builds the URL from the page origin
 * (whether served by the Omnigent server directly or through the Vite dev proxy),
 * and an embedding host rebases it onto its proxied WS surface.
 *
 * When host routing is enabled, append `?omnigent_slice_key=<frozen modal
 * host>`. A browser WebSocket handshake can't set request headers, so the
 * routing key rides the query string (the same seam the terminal-attach WS
 * uses). This WS watches sessions across MANY hosts, so no single key is
 * "correct" — it's a NICE-TO-HAVE load/perf lever: keying by the modal host
 * (the one backing most of the user's sessions) lands the standing rescan on
 * the replica most likely holding their sessions' tunnels, so the per-session
 * status read hits that replica's warm relay cache instead of the cross-replica
 * fallback, and spreads the standing connections finer than per-tenant.
 * Correctness is unaffected (the rescan reads are replica-safe).
 *
 * The key comes from {@link modalHostId}, which is resolved once and never
 * changes for the page — so every auto-reconnect rebuilds the identical URL and
 * never re-keys (no connection churn). The provider only calls `start()` once
 * the modal host is resolved (see `isModalHostResolved`), so this reads a
 * settled value. Omitted on an unsharded server and when no host was picked.
 *
 * @returns The fully-qualified WebSocket URL.
 */
function buildUpdatesUrl(): string {
  const path = "/v1/sessions/updates";
  if (!isHostRoutingEnabled()) return resolveWebSocketUrl(path);
  const sliceKey = modalHostId();
  return resolveWebSocketUrl(
    sliceKey ? `${path}?omnigent_slice_key=${encodeURIComponent(sliceKey)}` : path,
  );
}

/**
 * Singleton transport for the session-updates WebSocket. One instance per
 * tab; {@link SessionUpdatesProvider} starts it once at app mount.
 */
class SessionUpdatesSocket {
  private ws: WebSocket | null = null;
  private watched: string[] = [];
  private watchedKey = "";
  private readonly listeners = new Set<FrameListener>();
  private readonly statusListeners = new Set<() => void>();
  private connected = false;
  private failedAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private transcriptCapability: boolean | null = null;
  private transcriptWindowCapability = false;
  private feedVersion = 1;
  private membershipLimit = Infinity;
  private reservations = 0;
  private readonly waitingMemberships = new Set<() => void>();

  /** FIFO per physical tab socket; hidden/cancelled waiters release their place immediately. */
  reserveMembership(signal: AbortSignal): Promise<() => void> {
    if (!this.supportsVersionedFeed()) return Promise.resolve(() => {});
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waitingMemberships.delete(grant);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const grant = () => {
        signal.removeEventListener("abort", abort);
        this.waitingMemberships.delete(grant);
        this.reservations++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.reservations--;
          this.waitingMemberships.values().next().value?.();
        });
      };
      if (signal.aborted) abort();
      else if (this.reservations < this.membershipLimit && !this.waitingMemberships.size) grant();
      else {
        this.waitingMemberships.add(grant);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }
  private readonly capabilityListeners = new Set<() => void>();
  private readonly transcripts = new Map<string, TranscriptSubscription>();

  supportsTranscripts(): boolean {
    // This socket is pinned to the modal host; routed sessions retain their own replica path.
    return this.transcriptCapability === true && !isHostRoutingEnabled();
  }

  supportsVersionedFeed(): boolean {
    return this.supportsTranscripts() && this.feedVersion === 2;
  }

  supportsTranscriptWindows(): boolean {
    return this.transcriptCapability === true && this.transcriptWindowCapability;
  }

  subscribeCapabilities(listener: () => void): () => void {
    this.capabilityListeners.add(listener);
    return () => this.capabilityListeners.delete(listener);
  }

  /** Legacy sockets ignore subscribe; bounded negotiation keeps their SSE path usable. */
  negotiateTranscript(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || typeof WebSocket === "undefined" || isHostRoutingEnabled())
      return Promise.resolve(false);
    if (!this.started && (!isHostRoutingEnabled() || isModalHostResolved())) this.start();
    if (this.transcriptCapability !== null) return Promise.resolve(this.transcriptCapability);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.capabilityListeners.delete(finish);
        signal.removeEventListener("abort", finish);
        resolve(!signal.aborted && this.supportsTranscripts());
      };
      const timer = setTimeout(finish, TRANSCRIPT_NEGOTIATION_MS);
      this.capabilityListeners.add(finish);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  /** One independently cancellable conversation on the tab's existing socket. */
  async openTranscript(
    sessionId: string,
    signal: AbortSignal,
    cursor: TranscriptCursor,
    idle: boolean,
    received?: (event: StreamEvent) => void,
    attemptId?: string,
  ): Promise<TranscriptResponse | null> {
    if (!(await this.negotiateTranscript(signal))) return null;
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    // A known compatible server reconnects through this socket; never open a parallel SSE.
    if (!this.connected)
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = this.subscribeStatus(() => {
          if (this.connected) {
            cleanup();
            resolve();
          }
        });
        const abort = () => {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
        };
        const cleanup = () => {
          unsubscribe();
          signal.removeEventListener("abort", abort);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    this.transcripts.get(sessionId)?.close();
    let subscription: TranscriptSubscription;
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      if (this.transcripts.get(sessionId) !== subscription) return;
      this.transcripts.delete(sessionId);
      this.send({
        type: "unsubscribe",
        session_id: sessionId,
        subscription_id: subscription.subscriptionId,
      });
    };
    const abort = () => subscription.close();
    subscription = transcriptEventStream(cleanup);
    subscription.received = received;
    if (this.supportsVersionedFeed())
      subscription.subscriptionId = attemptId ?? crypto.randomUUID();
    this.transcripts.set(sessionId, subscription);
    signal.addEventListener("abort", abort, { once: true });
    const { window_start_position, ...resume } = cursor;
    this.send({
      type: "subscribe",
      subscription_id: subscription.subscriptionId,
      item_references: true,
      session_id: sessionId,
      ...resume,
      idle,
      ...(this.supportsTranscriptWindows()
        ? {
            initial_limit: 100,
            ...(window_start_position !== undefined ? { window_start_position } : {}),
          }
        : {}),
    });
    return { ok: true, status: 200, headers: new Headers(), body: subscription.body };
  }

  reportPresence(idle: boolean): void {
    if (this.supportsTranscripts()) this.send({ type: "presence", idle });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  /** Open the connection (idempotent). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  /** Close the connection and stop reconnecting. */
  stop(): void {
    this.started = false;
    this.clearWatchdog();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // Drop handlers first so the close doesn't schedule a reconnect.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
    this.setConnected(false);
    for (const subscription of [...this.transcripts.values()]) subscription.close();
    this.transcriptCapability = null;
    this.transcriptWindowCapability = false;
    this.feedVersion = 1;
    for (const listener of this.capabilityListeners) listener();
  }

  /**
   * Whether the stream is currently open. Consumers use this to tune their
   * HTTP fallback cadence: a live stream keeps watched rows fresh by push,
   * but list-level discovery still needs occasional reconciliation.
   *
   * @returns `true` when the WebSocket is open.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Subscribe to connection-state changes (for ``useSyncExternalStore``).
   *
   * @param listener - Called whenever {@link isConnected} flips.
   * @returns An unsubscribe function.
   */
  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    for (const listener of this.statusListeners) listener();
  }

  /**
   * Update the set of session ids to watch. Sent to the server immediately
   * when connected. A no-op when the set is unchanged (order-insensitive),
   * so callers can recompute and push freely without churning the server.
   *
   * @param ids - Conversation ids currently displayed.
   */
  setWatched(ids: string[]): void {
    const key = [...ids].sort().join(",");
    if (key === this.watchedKey) return;
    this.watchedKey = key;
    this.watched = ids;
    this.sendWatch();
  }

  /**
   * Subscribe to parsed server frames.
   *
   * @param listener - Called for every frame received.
   * @returns An unsubscribe function.
   */
  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildUpdatesUrl());
    } catch (err) {
      // Construction can throw on a malformed URL / blocked context; treat
      // it as a failed open and retry with backoff.
      console.warn("[session-updates] WebSocket construction failed", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.failedAttempts = 0;
      this.setConnected(true);
      // Start the silence watchdog: from here we expect at least a
      // heartbeat within the window or we treat the link as dead.
      this.armWatchdog();
      this.sendWatch();
    };
    ws.onmessage = (event) => {
      if (this.ws === ws) this.handleMessage(event);
    };
    ws.onerror = () => {
      // `onerror` is always followed by `onclose`; let close drive retry.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.transcriptCapability = null;
      this.transcriptWindowCapability = false;
      this.feedVersion = 1;
      this.ws = null;
      this.clearWatchdog();
      this.setConnected(false);
      for (const subscription of [...this.transcripts.values()]) subscription.close();
      if (this.started) this.scheduleReconnect();
    };
  }

  /**
   * (Re)arm the silence watchdog. Called on connect and on every received
   * frame, so a steady stream of heartbeats / deltas keeps pushing the
   * deadline out; a stall trips {@link handleWatchdogExpiry}.
   */
  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      this.handleWatchdogExpiry();
    }, HEARTBEAT_WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * No frame arrived within the watchdog window — assume the socket is
   * silently dead and force a reconnect. Closing it runs the normal
   * `onclose` path (mark disconnected → schedule reconnect with backoff),
   * which also flips consumers back to their HTTP fallback poll until the
   * stream is live again.
   */
  private handleWatchdogExpiry(): void {
    if (!this.started || this.ws === null) return;
    console.warn(`[session-updates] no frame in ${HEARTBEAT_WATCHDOG_MS} ms; reconnecting`);
    // close() drives onclose → setConnected(false) → scheduleReconnect.
    this.ws.close();
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== null) return;
    this.failedAttempts += 1;
    const delay = nextReconnectDelay(this.failedAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started) this.connect();
    }, delay);
  }

  private sendWatch(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "watch", session_ids: this.watched }));
    }
  }

  private handleMessage(event: MessageEvent): void {
    // Any inbound message — even a heartbeat or one we can't parse — proves
    // the link is alive, so push the silence deadline out.
    this.armWatchdog();
    if (typeof event.data !== "string") return;
    let frame:
      | SessionUpdatesFrame
      | {
          type: "session.event";
          session_id: string;
          subscription_id?: string;
          event: Record<string, unknown>;
        }
      | { type: "session.error"; session_id: string; subscription_id?: string; code: string };
    try {
      frame = JSON.parse(event.data) as typeof frame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "capabilities") {
      this.transcriptCapability = frame.transcript_stream === 1;
      this.transcriptWindowCapability = frame.transcript_window === 1;
      this.membershipLimit =
        typeof frame.transcript_memberships === "number" &&
        Number.isSafeInteger(frame.transcript_memberships) &&
        frame.transcript_memberships > 0
          ? frame.transcript_memberships
          : Infinity;
      let override: string | null = null;
      try {
        override = localStorage.getItem("triune:transcript-feed");
      } catch {
        // Browsers without persistent storage use server negotiation.
      }
      this.feedVersion =
        frame.transcript_feed === 2 &&
        override !== "1" &&
        (override === "2" || frame.transcript_feed_default === 2)
          ? 2
          : 1;
      for (const listener of [...this.capabilityListeners]) listener();
    }
    if (frame.type === "session.event" || frame.type === "session.error") {
      const subscription = this.transcripts.get(frame.session_id);
      if (!subscription || frame.subscription_id !== subscription.subscriptionId) return;
      if (frame.type === "session.error") {
        subscription.received?.({ type: "session_transport_error", code: frame.code });
        subscription.push(
          { type: "session_transport_error", code: frame.code },
          event.data.length * 2,
        );
        subscription.close();
        // Authorization failures settle only this membership; other streams stay connected.
        if (!isRetryableTranscriptError(frame.code))
          console.warn(`[session-updates] transcript ${frame.session_id}: ${frame.code}`);
        return;
      }
      const payload = frame.event;
      if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;
      if (payload.type === "session.snapshot_page" && subscription.subscriptionId) {
        if (!Array.isArray(payload.items) || payload.items.length > 32) {
          subscription.push({ type: "session_transport_error", code: "stream_failed" }, 0);
          return;
        }
        for (const item of payload.items) {
          const parsed = parseEvent("response.output_item.done", { item });
          if (!parsed) {
            subscription.push({ type: "session_transport_error", code: "stream_failed" }, 0);
            return;
          }
          subscription.received?.(parsed);
          subscription.push(parsed, new TextEncoder().encode(JSON.stringify(item)).byteLength);
        }
        return;
      }
      const parsed = parseEvent(payload.type, payload);
      if (parsed && subscription.subscriptionId) {
        const field = "_change_revision";
        const revision =
          payload[field] ??
          (parsed.type === "session_item_reference" ? parsed.header[field] : undefined);
        if (typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0)
          parsed.changeRevision = revision;
      }
      if (parsed) {
        subscription.received?.(parsed);
        subscription.push(parsed, new TextEncoder().encode(event.data).byteLength);
      }
      return;
    }
    for (const listener of this.listeners) listener(frame);
  }
}

/** Shared transport instance for the current tab. */
export const sessionUpdatesSocket = new SessionUpdatesSocket();

/**
 * Resolve with the first pushed session row matching `match`.
 *
 * The server announces a session on this stream as soon as its row is
 * written — well before a `POST /v1/sessions` that waits on a host runner
 * launch answers with the same id. A caller that knows what it just asked
 * for can use this to learn its own session's id early and open the chat
 * without waiting for the create.
 *
 * The stream carries EVERY session that becomes visible to this user —
 * created in another tab, started by a scheduled task, or just shared with
 * them — and restates rows already on screen on each snapshot. So `match`
 * must identify one specific expected session; "anything new" would hand
 * back somebody else's.
 *
 * @param match - Predicate over each row of a snapshot/changed frame.
 * @param signal - Stops listening when aborted, resolving `null` so the
 *   caller can fall back to its own result.
 * @returns The first matching row, or `null` if aborted before one arrived.
 */
export function nextPushedSession(
  match: (item: SessionListWireItem) => boolean,
  signal: AbortSignal,
): Promise<SessionListWireItem | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const onAbort = () => {
      unsubscribe();
      resolve(null);
    };
    unsubscribe = sessionUpdatesSocket.subscribe((frame) => {
      if (frame.type !== "snapshot" && frame.type !== "changed") return;
      const found = frame.items.find(match);
      if (found === undefined) return;
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      resolve(found);
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
