// Modified for Triune.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as host from "./host";
import {
  HEARTBEAT_WATCHDOG_MS,
  nextPushedSession,
  sessionUpdatesSocket,
  TRANSCRIPT_NEGOTIATION_MS,
} from "./sessionUpdatesSocket";

// Minimal stand-in for the browser WebSocket: records sends/closes and lets
// the test drive the lifecycle (open, message) by hand. A real socket can't be
// opened in jsdom, and we need deterministic control over when frames arrive
// relative to the watchdog deadline — so this is the transport-level mock the
// testing guide allows.
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCount = 0;
  readonly url: string;
  readonly sent: Record<string, unknown>[] = [];

  constructor(url: string) {
    // Plain field assignment, not a TS parameter property — the latter is
    // forbidden by `erasableSyntaxOnly` in tsconfig.app.json.
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  /** Test helper: complete the handshake (fires the socket's onopen). */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: deliver one server text frame. */
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

/** The socket constructed most recently by start()/reconnect. */
function latestWs(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no WebSocket was constructed");
  return ws;
}

describe("sessionUpdatesSocket heartbeat watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    // Tear down the shared singleton's connection + timers so cases don't leak
    // into each other, then restore real timers/globals.
    sessionUpdatesSocket.stop();
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("routes an OSS WebSocket by the same host key after reconnecting", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_OMNIGENT_HOST_ROUTING", "true");
    const { resolveModalHost, setSessionHost } = await import("./sessionHost");
    const { sessionUpdatesSocket: socket } = await import("./sessionUpdatesSocket");
    setSessionHost("sess_oss", "host_oss");
    resolveModalHost();
    try {
      socket.start();
      const first = latestWs();
      expect(new URL(first.url).searchParams.get("omnigent_slice_key")).toBe("host_oss");
      first.open();
      first.close();
      vi.advanceTimersByTime(RECONNECT_CEILING_MS);
      expect(latestWs()).not.toBe(first);
      expect(latestWs().url).toBe(first.url);
    } finally {
      socket.stop();
      vi.resetModules();
    }
  });

  it("forces a reconnect after the watchdog window of total silence", () => {
    sessionUpdatesSocket.start();
    const ws = latestWs();
    ws.open();
    expect(sessionUpdatesSocket.isConnected()).toBe(true);

    // One tick short of the deadline: still alive, not closed.
    vi.advanceTimersByTime(HEARTBEAT_WATCHDOG_MS - 1);
    expect(ws.closeCount).toBe(0);
    expect(sessionUpdatesSocket.isConnected()).toBe(true);

    // Crossing the deadline with zero frames trips the watchdog, which closes
    // the dead socket; onclose flips us to disconnected so consumers resume
    // their HTTP fallback poll.
    vi.advanceTimersByTime(1);
    expect(ws.closeCount).toBe(1);
    expect(sessionUpdatesSocket.isConnected()).toBe(false);

    // The close scheduled a reconnect; after the (jittered, ≤5 s) backoff a
    // fresh socket is constructed — the stream tries to come back, it doesn't
    // just give up.
    const before = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(RECONNECT_CEILING_MS);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it("keeps the connection alive when a heartbeat arrives before the deadline", () => {
    sessionUpdatesSocket.start();
    const ws = latestWs();
    ws.open();

    // A heartbeat just before the deadline must reset the watchdog...
    vi.advanceTimersByTime(HEARTBEAT_WATCHDOG_MS - 1);
    ws.emit({ type: "heartbeat" });

    // ...so advancing nearly another full window still doesn't close it. If the
    // watchdog hadn't reset, this second advance would have tripped it.
    vi.advanceTimersByTime(HEARTBEAT_WATCHDOG_MS - 1);
    expect(ws.closeCount).toBe(0);
    expect(sessionUpdatesSocket.isConnected()).toBe(true);

    // It still fires on a genuine stall after the last frame.
    vi.advanceTimersByTime(1);
    expect(ws.closeCount).toBe(1);
    expect(sessionUpdatesSocket.isConnected()).toBe(false);
  });
});

// Reconnect backoff is capped at 5 s + jitter; advancing past 5 s guarantees
// the scheduled reconnect timer has fired regardless of the random jitter.
const RECONNECT_CEILING_MS = 5_001;

describe("nextPushedSession", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    sessionUpdatesSocket.stop();
    vi.unstubAllGlobals();
  });

  it("waits for the row the caller is expecting, not merely the next new one", async () => {
    sessionUpdatesSocket.start();
    const ws = latestWs();
    ws.open();
    const abort = new AbortController();
    const mine = nextPushedSession((item) => item.id === "conv_mine", abort.signal);

    // A session the caller didn't create lands first — another tab, a
    // scheduled task, one just shared with them. The stream announces those
    // identically, so settling on "something new arrived" would hand back the
    // wrong conversation (and the caller's first message with it).
    ws.emit({ type: "changed", items: [{ id: "conv_theirs" }] });
    ws.emit({ type: "changed", items: [{ id: "conv_mine", agent_id: "ag_1" }] });

    await expect(mine).resolves.toMatchObject({ id: "conv_mine", agent_id: "ag_1" });
  });

  it("resolves null once aborted so the caller falls back to its own result", async () => {
    sessionUpdatesSocket.start();
    latestWs().open();
    const abort = new AbortController();
    const mine = nextPushedSession(() => true, abort.signal);

    abort.abort();
    await expect(mine).resolves.toBeNull();

    // Settled for good: a late frame must not revive it, or a caller that
    // already committed to the authoritative id would be handed a second one.
    latestWs().emit({ type: "changed", items: [{ id: "conv_late" }] });
    await expect(mine).resolves.toBeNull();
  });
});

describe("sessionUpdatesSocket transcript multiplexing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    sessionUpdatesSocket.start();
    latestWs().open();
  });
  afterEach(() => {
    sessionUpdatesSocket.stop();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const ready = () => latestWs().emit({ type: "capabilities", transcript_stream: 1 });
  const event = (id: string, text: string) =>
    latestWs().emit({
      type: "session.event",
      session_id: id,
      event: { type: "response.output_text.delta", delta: text },
    });

  it("holds a known membership through a socket outage and transfers to SSE when the replacement peer has no feed", async () => {
    ready();
    const original = latestWs();
    original.close();
    expect(sessionUpdatesSocket.supportsTranscripts()).toBe(true);
    const opening = sessionUpdatesSocket.openTranscript(
      "resume",
      new AbortController().signal,
      { after_position: 0 },
      false,
    );
    await vi.advanceTimersByTimeAsync(5000);
    const replacement = latestWs();
    expect(replacement).not.toBe(original);
    replacement.open();
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_NEGOTIATION_MS);
    expect(await opening).toBeNull();
    expect(replacement.sent.some((f) => f.type === "subscribe")).toBe(false);
    expect(sessionUpdatesSocket.supportsTranscripts()).toBe(false);
  });

  it("admits waiting panes in arrival order and removes cancelled waiters", async () => {
    latestWs().emit({
      type: "capabilities",
      transcript_stream: 1,
      transcript_feed: 2,
      transcript_feed_default: 2,
      transcript_memberships: 1,
    });
    const holder = await sessionUpdatesSocket.reserveMembership(new AbortController().signal);
    const hidden = new AbortController();
    const skipped = sessionUpdatesSocket.reserveMembership(hidden.signal);
    const granted: string[] = [];
    const first = sessionUpdatesSocket
      .reserveMembership(new AbortController().signal)
      .then((release) => {
        granted.push("first");
        return release;
      });
    const second = sessionUpdatesSocket
      .reserveMembership(new AbortController().signal)
      .then((release) => {
        granted.push("second");
        return release;
      });
    hidden.abort();
    await expect(skipped).rejects.toThrow("Aborted");
    holder();
    const release = await first;
    expect(granted).toEqual(["first"]);
    release();
    (await second)();
    expect(granted).toEqual(["first", "second"]);
  });

  it("ignores retired membership frames while expanding negotiated snapshot rows", async () => {
    latestWs().emit({
      type: "capabilities",
      transcript_stream: 1,
      transcript_feed: 2,
      transcript_feed_default: 2,
    });
    const first = new AbortController();
    await sessionUpdatesSocket.openTranscript("chat", first.signal, { after_position: -1 }, false);
    const old = latestWs().sent.at(-1)!.subscription_id;
    first.abort();
    const active = await sessionUpdatesSocket.openTranscript(
      "chat",
      new AbortController().signal,
      { after_position: -1 },
      false,
    );
    const id = latestWs().sent.at(-1)!.subscription_id;
    expect(typeof id).toBe("string");
    expect(id).not.toBe(old);
    latestWs().emit({
      type: "session.error",
      session_id: "chat",
      subscription_id: old,
      code: "forbidden",
    });
    latestWs().emit({
      type: "session.event",
      session_id: "chat",
      subscription_id: id,
      event: {
        type: "session.snapshot_page",
        items: [
          {
            type: "message",
            id: "durable",
            response_id: "turn",
            position: 0,
            role: "user",
            content: [],
          },
        ],
      },
    });
    const reader = active!.body.getReader();
    expect((await reader.read()).value?.committedItem?.id).toBe("durable");
    await reader.cancel();
  });

  it("preserves the per-session replica route when host routing is enabled", async () => {
    const routing = vi.spyOn(host, "isHostRoutingEnabled").mockReturnValue(true);
    ready();
    expect(sessionUpdatesSocket.supportsTranscripts()).toBe(false);
    expect(
      await sessionUpdatesSocket.openTranscript(
        "remote-session",
        new AbortController().signal,
        { after_position: -1 },
        false,
      ),
    ).toBeNull();
    expect(latestWs().sent.some((frame) => frame.type === "subscribe")).toBe(false);
    routing.mockRestore();
  });

  it("bounds legacy capability negotiation without sending an ignored subscription", async () => {
    const controller = new AbortController();
    const open = sessionUpdatesSocket.openTranscript(
      "legacy",
      controller.signal,
      { after_position: -1 },
      false,
    );
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_NEGOTIATION_MS - 1);
    expect(latestWs().sent.filter((frame) => frame.type === "subscribe")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await open).toBeNull();
    ready();
    expect(sessionUpdatesSocket.supportsTranscripts()).toBe(true);
  });

  it("routes two transcripts and watch traffic over one socket with independent cancellation", async () => {
    ready();
    const a = new AbortController();
    const b = new AbortController();
    const first = await sessionUpdatesSocket.openTranscript(
      "a",
      a.signal,
      { after_position: 10, after_revision: 22, stream_epoch: "epoch" },
      false,
    );
    const second = await sessionUpdatesSocket.openTranscript(
      "b",
      b.signal,
      { after_position: -1 },
      true,
    );
    const firstReader = first!.body!.getReader();
    const secondReader = second!.body!.getReader();
    const listFrames: unknown[] = [];
    const stop = sessionUpdatesSocket.subscribe((frame) => listFrames.push(frame));
    try {
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(latestWs().sent).toContainEqual({
        type: "subscribe",
        item_references: true,
        session_id: "a",
        after_position: 10,
        after_revision: 22,
        stream_epoch: "epoch",
        idle: false,
      });
      event("unsubscribed", "private");
      event("a", "first");
      expect((await firstReader.read()).value).toMatchObject({
        type: "text_delta",
        delta: "first",
      });
      event("b", "second");
      expect((await secondReader.read()).value).toMatchObject({
        type: "text_delta",
        delta: "second",
      });
      latestWs().emit({ type: "changed", items: [] });
      expect(listFrames).toEqual([{ type: "changed", items: [] }]);
      a.abort();
      expect((await firstReader.read()).done).toBe(true);
      expect(latestWs().sent.at(-1)).toEqual({ type: "unsubscribe", session_id: "a" });
      event("b", "still live");
      expect((await secondReader.read()).value).toMatchObject({
        type: "text_delta",
        delta: "still live",
      });
      expect(latestWs().closeCount).toBe(0);
    } finally {
      stop();
      a.abort();
      b.abort();
    }
  });

  it.each([false, true])(
    "negotiates window options only when advertised (%s)",
    async (windowed) => {
      latestWs().emit({
        type: "capabilities",
        transcript_stream: 1,
        ...(windowed ? { transcript_window: 1 } : {}),
      });
      const controller = new AbortController();
      await sessionUpdatesSocket.openTranscript(
        "reader",
        controller.signal,
        {
          after_position: 9999,
          after_revision: 20,
          stream_epoch: "epoch",
          window_start_position: 9870,
        },
        false,
      );
      expect(latestWs().sent.at(-1)).toEqual({
        type: "subscribe",
        item_references: true,
        session_id: "reader",
        after_position: 9999,
        after_revision: 20,
        stream_epoch: "epoch",
        idle: false,
        ...(windowed ? { initial_limit: 100, window_start_position: 9870 } : {}),
      });
      sessionUpdatesSocket.stop();
      expect(sessionUpdatesSocket.supportsTranscriptWindows()).toBe(false);
    },
  );

  it("reports idle presence without recycling or resetting any membership", async () => {
    ready();
    const controller = new AbortController();
    await sessionUpdatesSocket.openTranscript(
      "a",
      controller.signal,
      { after_position: -1 },
      false,
    );
    const socket = latestWs();
    const before = socket.sent.length;
    sessionUpdatesSocket.reportPresence(true);
    sessionUpdatesSocket.reportPresence(false);
    expect(socket.sent.slice(before)).toEqual([
      { type: "presence", idle: true },
      { type: "presence", idle: false },
    ]);
    expect(socket.closeCount).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    controller.abort();
  });

  it("isolates a subscription authorization error and retains its explicit code", async () => {
    ready();
    const a = new AbortController();
    const b = new AbortController();
    const first = await sessionUpdatesSocket.openTranscript(
      "a",
      a.signal,
      { after_position: -1 },
      false,
    );
    const second = await sessionUpdatesSocket.openTranscript(
      "b",
      b.signal,
      { after_position: -1 },
      false,
    );
    const readA = first!.body!.getReader();
    const readB = second!.body!.getReader();
    latestWs().emit({ type: "session.error", session_id: "a", code: "forbidden" });
    expect((await readA.read()).value).toEqual({
      type: "session_transport_error",
      code: "forbidden",
    });
    expect((await readA.read()).done).toBe(true);
    event("b", "authorized");
    expect((await readB.read()).value).toMatchObject({ type: "text_delta", delta: "authorized" });
    expect(latestWs().closeCount).toBe(0);
    a.abort();
    b.abort();
  });

  it("does not deliver old-socket frames after scope stop and restart", async () => {
    ready();
    const old = latestWs();
    const staleMessage = old.onmessage!;
    sessionUpdatesSocket.stop();
    sessionUpdatesSocket.start();
    latestWs().open();
    ready();
    const controller = new AbortController();
    const response = await sessionUpdatesSocket.openTranscript(
      "same-id",
      controller.signal,
      { after_position: -1 },
      false,
    );
    staleMessage({
      data: JSON.stringify({
        type: "session.event",
        session_id: "same-id",
        event: { type: "response.output_text.delta", delta: "old viewer" },
      }),
    } as MessageEvent);
    event("same-id", "current viewer");
    expect((await response!.body!.getReader().read()).value).toMatchObject({
      type: "text_delta",
      delta: "current viewer",
    });
    controller.abort();
  });
});
