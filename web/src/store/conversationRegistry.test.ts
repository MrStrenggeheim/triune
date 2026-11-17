// Modified for Triune.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationRegistry,
  MAX_CLEAN_INACTIVE_HISTORY,
  getConnectionProtocol,
  maxLiveConversations,
} from "./conversationRegistry";
import * as capabilities from "@/lib/capabilities";
import { readTranscriptReaderCheckpoint } from "@/lib/transcriptReaderCheckpoint";
import { setSessionDraft } from "@/lib/sessionDrafts";
import type { AnyBlock } from "@/lib/blocks";
import type { ConversationState, PendingUserMessage } from "./chatStore";

/** An unsettled optimistic bubble — the shape that pins an entry. */
function unsentBubble(tempId = "pend_1"): PendingUserMessage {
  return { tempId, content: [{ type: "input_text", text: "hi" }] };
}

/** A bubble whose POST has returned; the server owns it now. */
function postedBubble(tempId = "pend_1"): PendingUserMessage {
  return { ...unsentBubble(tempId), posted: true };
}

describe("maxLiveConversations", () => {
  it.each([undefined, false, true])(
    "keeps the serial limit at three unless grids are enabled (%s)",
    (enabled) => {
      const cached = vi.spyOn(capabilities, "getCachedServerInfo").mockReturnValue({
        ...capabilities.FALLBACK_SERVER_INFO,
        features: enabled === undefined ? {} : { grid_sessions_display_ui: enabled },
      });
      expect(maxLiveConversations("multiplexed")).toBe(30);
      expect(maxLiveConversations("serial")).toBe(enabled ? 4 : 3);
      cached.mockRestore();
    },
  );
});

describe("getConnectionProtocol", () => {
  /** Pin the navigation entry's negotiated ALPN id. */
  function withNextHop<T>(nextHopProtocol: string | undefined, body: () => T): T {
    const spy = vi
      .spyOn(performance, "getEntriesByType")
      .mockReturnValue(
        nextHopProtocol === undefined ? [] : [{ nextHopProtocol } as unknown as PerformanceEntry],
      );
    try {
      return body();
    } finally {
      spy.mockRestore();
    }
  }

  it("reads the negotiated protocol rather than the URL scheme", () => {
    // The scheme does not imply the protocol: an HTTPS origin that negotiated
    // HTTP/1.1 has the same ~6-connection ceiling as the dev server, so
    // treating it as multiplexed would deadlock the pool.
    expect(withNextHop("h2", getConnectionProtocol)).toBe("multiplexed");
    expect(withNextHop("h3", getConnectionProtocol)).toBe("multiplexed");
    expect(withNextHop("http/1.1", getConnectionProtocol)).toBe("serial");
  });

  it("reserves serial fetch capacity when navigation timing is unavailable", () => {
    expect(withNextHop(undefined, getConnectionProtocol)).toBe("serial");
  });

  it("treats an empty nextHopProtocol as unknown", () => {
    // Cross-origin and cached navigations report "" — not a serial transport.
    expect(withNextHop("", getConnectionProtocol)).toBe("serial");
  });
});

describe("ConversationRegistry", () => {
  let registry: ConversationRegistry;

  beforeEach(() => {
    registry = new ConversationRegistry();
  });

  it("creates an entry on first acquire and returns the same one after", () => {
    const first = registry.acquire("conv_a");
    expect(first.id).toBe("conv_a");
    expect(registry.acquire("conv_a")).toBe(first);
    expect(registry.ids()).toEqual(["conv_a"]);
  });

  it("starts an entry from the initial conversation state", () => {
    const entry = registry.acquire("conv_a");
    expect(entry.getState().blocks).toEqual([]);
    expect(entry.getState().sessionStatus).toBe("idle");
    expect(entry.disposed).toBe(false);
  });

  it("keeps each entry's state independent", () => {
    const a = registry.acquire("conv_a");
    const b = registry.acquire("conv_b");
    a.setState({ sessionStatus: "running" });
    // The whole point: a background conversation's status cannot bleed.
    expect(a.getState().sessionStatus).toBe("running");
    expect(b.getState().sessionStatus).toBe("idle");
  });

  it("notifies subscribers with the id of the entry that changed", () => {
    const seen: string[] = [];
    registry.subscribe((id) => seen.push(id));
    const a = registry.acquire("conv_a");
    const b = registry.acquire("conv_b");
    a.setState({ sessionStatus: "running" });
    b.setState({ status: "streaming" });
    expect(seen).toEqual(["conv_a", "conv_b"]);
  });

  it("does not notify when a patch changes nothing", () => {
    const entry = registry.acquire("conv_a");
    const listener = vi.fn();
    registry.subscribe(listener);
    entry.setState({ sessionStatus: "idle" }); // already idle
    expect(listener).not.toHaveBeenCalled();
  });

  it("evictLruEvictable disposes the least-recently-viewed entry and returns its id", () => {
    // The slot layer calls this to reclaim one of this tab's own background
    // streams when the origin is saturated. conv_a is oldest → it goes.
    const a = registry.acquire("conv_a");
    registry.acquire("conv_b");
    registry.acquire("conv_c");
    expect(registry.evictLruEvictable()).toBe("conv_a");
    expect(a.disposed).toBe(true);
    expect(registry.ids()).toEqual(["conv_b", "conv_c"]);
  });

  it("returns null when there is nothing to evict", () => {
    expect(registry.evictLruEvictable()).toBeNull();
  });

  it("keeps all four visible grid panes live until their final owner unmounts", () => {
    const releases = ["a", "b", "c", "d"].map((id) => {
      registry.acquire(id);
      return registry.retain(id);
    });
    const releaseSecondOwner = registry.retain("a");
    registry.acquire("background");
    expect(registry.evictLruEvictable()).toBe("background");
    expect(registry.evictLruEvictable()).toBeNull();
    releases[0]();
    expect(registry.evictLruEvictable()).toBeNull();
    releaseSecondOwner();
    expect(registry.evictLruEvictable()).toBe("a");
    releases.slice(1).forEach((release) => release());
    expect(registry.evictLruEvictable()).toBe("b");
  });

  it("detaches a hidden retained chat without losing its draft or transcript state", () => {
    const entry = registry.acquire("remembered");
    const controller = new AbortController();
    const draft = { conversationId: "remembered", text: "retry with context", files: [] };
    entry.setState({ abortController: controller, failedSendDraft: draft, oldestItemId: "anchor" });
    registry.setActive("remembered");
    const release = registry.retain("remembered", false);
    expect(controller.signal.aborted).toBe(true);
    expect(registry.isVisible("remembered")).toBe(false);
    expect(registry.peek("remembered")).toBe(entry);
    expect(entry.getState()).toMatchObject({ failedSendDraft: draft, oldestItemId: "anchor" });
    expect(entry.disposed).toBe(false);
    release();
  });

  it("releases independent focus leases without releasing visible observation", () => {
    const entry = registry.acquire("pane");
    const controller = new AbortController();
    entry.setState({ abortController: controller });
    const releaseVisible = registry.retain("pane", true, false);
    const releaseFirstFocus = registry.retainFocus("pane");
    const releaseSecondFocus = registry.retainFocus("pane");
    releaseFirstFocus();
    releaseFirstFocus();
    expect(registry.isFocused("pane")).toBe(true);
    releaseSecondFocus();
    expect(registry.isFocused("pane")).toBe(false);
    expect(registry.isVisible("pane")).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    const releaseSecondVisible = registry.retain("pane", true, false);
    releaseVisible();
    expect(controller.signal.aborted).toBe(false);
    releaseSecondVisible();
    releaseSecondVisible();
    expect(controller.signal.aborted).toBe(true);
  });

  it("reclaims observation from unsent work while preserving its only copy", () => {
    const entry = registry.acquire("unsent");
    const controller = new AbortController();
    entry.setState({ abortController: controller, pendingUserMessages: [unsentBubble()] });
    registry.acquire("visible");
    registry.setActive("visible");
    expect(registry.evictLruEvictable()).toBe("unsent");
    expect(controller.signal.aborted).toBe(true);
    expect(registry.peek("unsent")).toBe(entry);
    expect(entry.getState().pendingUserMessages).toEqual([unsentBubble()]);
    expect(registry.evictLruEvictable()).toBeNull();
  });

  it("treats acquire as a recency touch, so a revisited entry is not the victim", () => {
    registry.acquire("conv_a");
    registry.acquire("conv_b");
    registry.acquire("conv_c");
    registry.acquire("conv_a"); // revisit → conv_b is now oldest
    expect(registry.evictLruEvictable()).toBe("conv_b");
    expect(registry.ids()).toEqual(["conv_c", "conv_a"]);
  });

  it("never evicts the conversation on screen, even when it is oldest", () => {
    const a = registry.acquire("conv_a");
    registry.setActive("conv_a");
    registry.acquire("conv_b");
    // conv_a is oldest but on screen → skipped; conv_b is reclaimed instead.
    expect(registry.evictLruEvictable()).toBe("conv_b");
    expect(registry.has("conv_a")).toBe(true);
    expect(a.disposed).toBe(false);
  });

  it("never evicts the conversation being bound (exemptId)", () => {
    // The entry whose stream the slot layer is opening must survive — evicting
    // it would hand back a dead entry.
    registry.acquire("conv_a");
    registry.acquire("conv_d");
    expect(registry.evictLruEvictable("conv_d")).toBe("conv_a");
    expect(registry.has("conv_d")).toBe(true);
  });

  it("never evicts an entry holding a send the server has not acknowledged", () => {
    // The one case where eviction is NOT equivalent to a cold load: until the
    // POST returns, the message exists nowhere but this tab. Skip it, take next.
    const a = registry.acquire("conv_a");
    a.setState({ pendingUserMessages: [unsentBubble()] });
    registry.acquire("conv_b");
    expect(registry.evictLruEvictable()).toBe("conv_b");
    expect(registry.has("conv_a")).toBe(true);
    expect(a.disposed).toBe(false);
  });

  it("never evicts an entry holding a failed-send draft", () => {
    // A send that failed rolls its optimistic bubble back but stashes the text
    // + files as `failedSendDraft` — the only surviving copy, since the server
    // never received it. If that failure settles after the conversation was
    // backgrounded, the rolled-back bubble leaves nothing else pinning the
    // entry, so eviction would drop the retry draft. Pin on the draft too.
    const a = registry.acquire("conv_a");
    a.setState({
      pendingUserMessages: [], // bubble already rolled back
      failedSendDraft: { conversationId: "conv_a", text: "retry me", files: [] },
    });
    registry.acquire("conv_b");
    expect(registry.evictLruEvictable()).toBe("conv_b");
    expect(registry.has("conv_a")).toBe(true);
    expect(a.disposed).toBe(false);
  });

  it("evicts once a failed-send draft is cleared (composer restored it)", () => {
    // The pin releases as soon as the draft is consumed on return, so the entry
    // stops holding a slot the moment its retry copy is safe in the composer.
    const a = registry.acquire("conv_a");
    a.setState({ failedSendDraft: { conversationId: "conv_a", text: "x", files: [] } });
    a.setState({ failedSendDraft: null });
    expect(registry.evictLruEvictable()).toBe("conv_a");
    expect(a.disposed).toBe(true);
  });

  it("keeps posted optimistic input until canonical reconciliation", () => {
    const a = registry.acquire("conv_a");
    a.setState({ pendingUserMessages: [postedBubble()] });
    expect(registry.evictLruEvictable()).toBeNull();
    expect(a.disposed).toBe(false);
    a.setState({ pendingUserMessages: [] });
    expect(registry.evictLruEvictable()).toBe("conv_a");
    expect(a.disposed).toBe(true);
  });

  it("returns null when every entry is protected rather than destroying unsent work", () => {
    // The slot layer reads this null as "origin saturated, nothing of mine to
    // reclaim" and opens the active conversation over budget with the
    // too-many-tabs banner.
    const a = registry.acquire("conv_a");
    a.setState({ pendingUserMessages: [unsentBubble("pend_a")] });
    registry.acquire("conv_b").setState({ pendingUserMessages: [unsentBubble("pend_b")] });
    registry.setActive("conv_b"); // conv_b on screen, conv_a pinned
    expect(registry.evictLruEvictable()).toBeNull();
    expect(registry.ids()).toEqual(["conv_a", "conv_b"]);
  });

  it("aborts the stream when an entry is disposed", () => {
    const entry = registry.acquire("conv_a");
    const controller = new AbortController();
    entry.setState({ abortController: controller });
    registry.release("conv_a");
    expect(controller.signal.aborted).toBe(true);
    expect(entry.disposed).toBe(true);
  });

  it("drops writes to a disposed entry but still serves reads", () => {
    // In-flight async work must be able to unwind without resurrecting state
    // for an evicted conversation.
    const entry = registry.acquire("conv_a");
    entry.setState({ sessionStatus: "running" });
    registry.release("conv_a");
    entry.setState({ sessionStatus: "failed" });
    expect(entry.getState().sessionStatus).toBe("running");
  });

  it("is idempotent on repeated release and dispose", () => {
    const entry = registry.acquire("conv_a");
    registry.release("conv_a");
    expect(() => {
      registry.release("conv_a");
      entry.dispose();
    }).not.toThrow();
  });

  it("clears every entry", () => {
    const a = registry.acquire("conv_a");
    const b = registry.acquire("conv_b");
    registry.setActive("conv_a");
    registry.clear();
    expect(registry.ids()).toEqual([]);
    expect(a.disposed).toBe(true);
    expect(b.disposed).toBe(true);
    expect(registry.getActive()).toBeNull();
  });

  it("reports the active entry, and null once it is gone", () => {
    registry.acquire("conv_a");
    registry.setActive("conv_a");
    expect(registry.getActive()?.id).toBe("conv_a");
    registry.release("conv_a");
    expect(registry.getActive()).toBeNull();
  });

  it("rekey preserves state, moves the active pointer, and drops the old id", () => {
    const temp = registry.acquire("temp:aaaa0001");
    temp.setState({ status: "streaming" });
    registry.setActive("temp:aaaa0001");

    registry.rekey("temp:aaaa0001", "conv_real");

    expect(registry.has("temp:aaaa0001")).toBe(false);
    expect(temp.disposed).toBe(true);
    const real = registry.peek("conv_real");
    expect(real?.id).toBe("conv_real");
    expect(real?.getState().status).toBe("streaming"); // carried over
    expect(registry.getActive()?.id).toBe("conv_real"); // active pointer followed
  });

  it("rekey onto an already-live id keeps its state and carries pending messages", () => {
    const temp = registry.acquire("temp:aaaa0001");
    temp.setState({
      pendingUserMessages: [
        {
          tempId: "pend_1",
          content: [{ type: "input_text", text: "optimistic first message" }],
        },
      ],
    });
    const existing = registry.acquire("conv_real");
    registry.rekey("temp:aaaa0001", "conv_real");
    expect(registry.peek("conv_real")).toBe(existing);
    expect(existing.getState().pendingUserMessages).toEqual([
      {
        tempId: "pend_1",
        content: [{ type: "input_text", text: "optimistic first message" }],
      },
    ]);
    expect(temp.disposed).toBe(true);
    expect(registry.has("temp:aaaa0001")).toBe(false);
  });

  it("rekey is a no-op when the old id is not live", () => {
    registry.rekey("temp:deadbeef", "conv_real");
    expect(registry.has("conv_real")).toBe(false);
  });
});

function cleanBlock(id: string, position = 12): AnyBlock {
  return {
    type: "user_message",
    ctx: { itemId: id, position, responseId: id, agent: null, depth: 0, turn: 0, timestamp: 0 },
    content: [{ type: "input_text", text: "saved history" }],
  };
}

describe("bounded inactive history", () => {
  it("retires 80 of 100 clean entries, retaining recent entries and a compact loaded range", () => {
    const registry = new ConversationRegistry();
    const disposed = vi.fn();
    registry.subscribeDisposed(disposed);
    const first = registry.acquire("trim-0");
    first.setState({ blocks: [cleanBlock("saved-0")] });
    for (let index = 1; index < 100; index++)
      registry.acquire(`trim-${index}`).setState({ blocks: [cleanBlock(`saved-${index}`)] });
    expect(registry.ids()).toEqual(
      Array.from({ length: MAX_CLEAN_INACTIVE_HISTORY }, (_, i) => `trim-${80 + i}`),
    );
    expect(disposed).toHaveBeenCalledTimes(80);
    expect(first.disposed).toBe(true);
    expect(readTranscriptReaderCheckpoint("trim-0")).toEqual({
      loadedMinPosition: 12,
      firstItemId: "saved-0",
    });
    first.setState({ blocks: [] });
    expect(first.getState().blocks).toHaveLength(1);
    expect(registry.acquire("trim-0")).not.toBe(first);
    expect(registry.peek("trim-0")?.getState().blocks).toEqual([]);
    registry.clear();
  });

  it("keeps visible, mounted, active, Undo, draft files and queued work independently", async () => {
    const registry = new ConversationRegistry();
    const releases = [
      registry.retain("visible"),
      registry.retain("mounted", false),
      registry.retainHistory("undo"),
    ];
    registry.setActive("active");
    const file = new File([new Uint8Array([1, 2, 255])], "draft.bin");
    setSessionDraft("file-draft", { text: " ", files: [file] });
    const releaseQueue = registry.setWorkProtection((id) => id === "queue");
    const protectedIds = ["visible", "mounted", "undo", "active", "file-draft", "queue"];
    const entries = protectedIds.map((id) => registry.acquire(id));
    for (let i = 0; i < 100; i++) registry.acquire(`pressure-${i}`);
    expect(registry.ids()).toHaveLength(MAX_CLEAN_INACTIVE_HISTORY + protectedIds.length);
    entries.forEach((entry) => expect(registry.peek(entry.id)).toBe(entry));
    releases.forEach((release) => release());
    releaseQueue();
    registry.setActive(null);
    setSessionDraft("file-draft", { text: "", files: [] });
    await Promise.resolve();
    expect(registry.ids()).toHaveLength(MAX_CLEAN_INACTIVE_HISTORY);
    registry.clear();
  });

  it.each([
    { pendingUserMessages: [postedBubble()] },
    {
      failedSendDraft: {
        conversationId: "protected",
        text: "failed",
        files: [new File(["bytes"], "a.txt")],
      },
    },
    {
      restoredSendDraft: {
        conversationId: "protected",
        text: "restore",
        files: [],
        stableId: "restore",
        delivered: false,
      },
    },
    { pendingRetryStableId: "retry" },
    { blocks: [cleanBlock("live:provisional")] },
    {
      blocks: [
        { type: "elicitation", ctx: cleanBlock("approval").ctx, status: "pending" } as AnyBlock,
      ],
    },
    { sessionStatus: "running" },
    { sessionStatus: "waiting" },
    { backgroundTaskCount: 1 },
    { terminalPending: true },
  ] satisfies Partial<ConversationState>[])("protects unsettled local state %#", (patch) => {
    const registry = new ConversationRegistry();
    const entry = registry.acquire("protected");
    entry.setState(patch);
    for (let i = 0; i < 100; i++) registry.acquire(`clean-${i}`);
    expect(registry.peek("protected")).toBe(entry);
    expect(entry.getState()).toMatchObject(patch);
    registry.clear();
  });

  it("ignores old account leases and scheduled trims after disposal", async () => {
    const registry = new ConversationRegistry();
    const releaseOld = registry.retainHistory("same");
    registry.acquire("same").setState({ status: "streaming" });
    registry.clear();
    const releaseNew = registry.retainHistory("same");
    const entry = registry.acquire("same");
    releaseOld();
    for (let i = 0; i < 100; i++) registry.acquire(`new-${i}`);
    await Promise.resolve();
    expect(registry.peek("same")).toBe(entry);
    releaseNew();
    await Promise.resolve();
    expect(entry.disposed).toBe(true);
    registry.clear();
  });
});
