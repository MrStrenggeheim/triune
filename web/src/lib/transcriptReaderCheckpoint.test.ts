// Modified for Triune.
import { beforeEach, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ account: "reader-a", server: "server-a" }));
vi.mock("./host", () => ({ getOmnigentServerIdentity: () => identity.server }));
vi.mock("./identity", () => ({ getCurrentUserId: () => identity.account }));
beforeEach(() => {
  localStorage.clear();
  identity.account = "reader-a";
  identity.server = "server-a";
  vi.resetModules();
});

it("restores compact reader choices and hidden canonical extent after reload, scoped by view and account", async () => {
  const reader = await import("./transcriptReaderCheckpoint");
  const snapshot = {
    atBottom: false as const,
    anchorKey: "response:first",
    anchorItemId: "exact",
    anchorOffset: -10,
    fallbackOffset: 700,
  };
  reader.recordTranscriptLoadedRange("chat", 0, "hidden-first");
  reader.recordTranscriptLoadedRange("chat", 100, "later-page");
  reader.rememberTranscriptReaderCheckpoint(
    "chat",
    {
      snapshot,
      expandedHistoryId: "chat:inherited",
      revealedItemIds: ["exact"],
      originalItemIds: ["exact"],
      searchTarget: { itemId: "exact", start: 2, end: 5 },
    },
    "view-a",
  );
  reader.rememberTranscriptReaderCheckpoint("chat", { snapshot: { atBottom: true } }, "view-b");
  const scope = reader.transcriptReaderScope();
  vi.resetModules();
  const restored = await import("./transcriptReaderCheckpoint");
  expect(restored.readTranscriptReaderCheckpoint("chat", "view-a")).toMatchObject({
    snapshot,
    loadedMinPosition: 0,
    firstItemId: "hidden-first",
    originalItemIds: ["exact"],
    searchTarget: { itemId: "exact", start: 2, end: 5 },
  });
  expect(restored.readTranscriptReaderCheckpoint("chat", "view-b")?.snapshot).toEqual({
    atBottom: true,
  });
  identity.account = "reader-b";
  restored.rememberTranscriptReaderCheckpoint("chat", { snapshot }, "view-a", scope);
  expect(restored.readTranscriptReaderCheckpoint("chat", "view-a")).toBeUndefined();
  identity.account = "reader-a";
  identity.server = "server-b";
  expect(restored.readTranscriptReaderCheckpoint("chat", "view-a")).toBeUndefined();
});

it.each(["abort", "scope", "replacement"])(
  "rejects a stale hydration completion after %s",
  async (reason) => {
    const reader = await import("./transcriptReaderCheckpoint");
    let complete!: (ready: boolean) => void;
    const handler = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const dispose = reader.setTranscriptReaderHydrator(handler);
    const controller = new AbortController();
    const pending = reader.restoreTranscriptReaderCheckpoint(
      "chat",
      { loadedMinPosition: 0 },
      controller.signal,
    );
    await Promise.resolve();
    let replacement: (() => void) | undefined;
    if (reason === "abort") controller.abort();
    if (reason === "scope") identity.account = "reader-b";
    if (reason === "replacement")
      replacement = reader.setTranscriptReaderHydrator(async () => true);
    if (reason === "abort") expect(await pending).toBe(false);
    complete(true);
    expect(await pending).toBe(false);
    dispose();
    if (replacement) {
      expect(
        await reader.restoreTranscriptReaderCheckpoint("chat", {}, new AbortController().signal),
      ).toBe(true);
      replacement();
    }
  },
);

it("reports hydration failures and leaves an already cancelled view untouched", async () => {
  const reader = await import("./transcriptReaderCheckpoint");
  const failure = new Error("missing page");
  const handler = vi.fn(async () => {
    throw failure;
  });
  const dispose = reader.setTranscriptReaderHydrator(handler);
  await expect(
    reader.restoreTranscriptReaderCheckpoint("chat", {}, new AbortController().signal),
  ).rejects.toBe(failure);
  const cancelled = new AbortController();
  cancelled.abort();
  expect(await reader.restoreTranscriptReaderCheckpoint("chat", {}, cancelled.signal)).toBe(false);
  expect(handler).toHaveBeenCalledTimes(1);
  dispose();
});

it("falls back to the latest valid reader after saved view expiry without moving other exact views", async () => {
  const reader = await import("./transcriptReaderCheckpoint");
  const storage = await import("./resourceViewStorage");
  const snapshot = (offset: number) => ({
    atBottom: false as const,
    anchorKey: `user:${offset}`,
    anchorItemId: `item-${offset}`,
    anchorOffset: -7,
    fallbackOffset: offset,
  });
  reader.recordTranscriptLoadedRange("fallback-chat", 0, "hidden-first");
  reader.rememberTranscriptReaderCheckpoint("fallback-chat", { snapshot: snapshot(333) }, "view-a");
  reader.rememberTranscriptReaderCheckpoint(
    "fallback-chat",
    {
      snapshot: snapshot(777),
      expandedHistoryId: "history",
      originalItemIds: ["original"],
      searchTarget: { itemId: "original", start: 2, end: 7 },
      disclosures: { worked: { open: false, revealRequest: "1" } },
    },
    "view-b",
  );
  // Later teardown of the older view and canonical range refresh cannot steal recency.
  reader.rememberTranscriptReaderCheckpoint(
    "fallback-chat",
    { snapshot: snapshot(333) },
    "view-a",
    reader.transcriptReaderScope(),
    false,
  );
  reader.recordTranscriptLoadedRange("fallback-chat", 0, "hidden-first");
  storage.writeResourceViewState('transcript-reader:["fallback-chat","view-b"]', undefined);
  vi.resetModules();
  const reopened = await import("./transcriptReaderCheckpoint");
  expect(reopened.readTranscriptReaderCheckpoint("fallback-chat", "new-view")).toMatchObject({
    snapshot: snapshot(777),
    loadedMinPosition: 0,
    firstItemId: "hidden-first",
    expandedHistoryId: "history",
    originalItemIds: ["original"],
    searchTarget: { itemId: "original", start: 2, end: 7 },
    disclosures: { worked: { open: false, revealRequest: "1" } },
  });
  expect(reopened.readTranscriptReaderCheckpoint("fallback-chat", "view-a")?.snapshot).toEqual(
    snapshot(333),
  );
  // A new view forks its inherited position on its first metadata write.
  reopened.rememberTranscriptReaderCheckpoint(
    "fallback-chat",
    { revealedItemIds: ["original"] },
    "new-view",
  );
  reopened.rememberTranscriptReaderCheckpoint(
    "fallback-chat",
    { snapshot: snapshot(999) },
    "view-a",
  );
  expect(reopened.readTranscriptReaderCheckpoint("fallback-chat", "new-view")?.snapshot).toEqual(
    snapshot(777),
  );
  expect(
    reopened.readTranscriptReaderCheckpoint("fallback-chat", "another-view")?.snapshot,
  ).toEqual(snapshot(999));
});

it("does not promote invalid snapshots or let an invalid exact checkpoint hide the valid fallback", async () => {
  const reader = await import("./transcriptReaderCheckpoint");
  reader.rememberTranscriptReaderCheckpoint(
    "valid-reader",
    { snapshot: { atBottom: true } },
    "good",
  );
  reader.rememberTranscriptReaderCheckpoint(
    "valid-reader",
    { snapshot: { atBottom: false, anchorKey: null, anchorOffset: NaN, fallbackOffset: -1 } },
    "bad",
  );
  expect(reader.readTranscriptReaderCheckpoint("valid-reader", "new")?.snapshot).toEqual({
    atBottom: true,
  });
  expect(reader.readTranscriptReaderCheckpoint("valid-reader", "bad")?.snapshot).toEqual({
    atBottom: true,
  });
});
