// Modified for Triune.
import { IDBFactory } from "fake-indexeddb";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  persistMessageQueue,
  readQueuedMessages,
  writeQueuedMessages,
} from "./queuedMessagePersistence";
import { serializeReplyDraft } from "./replyDraft";
import type { QueuedMessage } from "@/store/chatStore";

const message = (queueId: string, text = queueId): QueuedMessage => ({
  queueId,
  text,
  conversationId: "chat-a",
  stableId: `stable-${queueId}`,
  agentId: "agent-a",
});
const store = (messages: QueuedMessage[] = []) => createStore(() => ({ queuedMessages: messages }));
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function contents(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

it("restores FIFO, files, reply context and retry flags after a fresh client boot", async () => {
  const errors = vi.fn();
  const original = store();
  const first = persistMessageQueue({
    store: original,
    scope: () => "server/owner",
    reportError: errors,
  });
  await first.settled();
  const replyDraft = {
    version: 1 as const,
    text: "reply",
    quotes: [{ before: "", text: "quoted" }],
  };
  const queued = {
    ...message("a", serializeReplyDraft(replyDraft)),
    replyDraft,
    files: [new File(["attachment bytes"], "notes.txt", { type: "text/plain", lastModified: 123 })],
    requiresRetry: true,
    workspaceRoot: "/captured/root",
    workspaceRevision: "captured-revision",
  };
  original.setState({
    queuedMessages: [queued, { ...message("b"), conversationId: "chat-b", waitingForHost: true }],
  });
  await first.settled();
  first.dispose();
  const fresh = store();
  const restored = vi.fn();
  const second = persistMessageQueue({
    store: fresh,
    scope: () => "server/owner",
    reportError: errors,
    restored,
  });
  await second.settled();
  expect(errors).not.toHaveBeenCalled();
  const rows = fresh.getState().queuedMessages;
  expect(rows.map((row) => row.queueId)).toEqual(["a", "b"]);
  expect(rows[0]).toMatchObject({
    stableId: "stable-a",
    requiresRetry: true,
    agentId: "agent-a",
    workspaceRoot: "/captured/root",
    workspaceRevision: "captured-revision",
    replyDraft,
  });
  expect(rows[1]).toMatchObject({ conversationId: "chat-b", waitingForHost: true });
  expect(rows[0].files?.[0]).toMatchObject({
    name: "notes.txt",
    type: "text/plain",
    lastModified: 123,
  });
  expect(await contents(rows[0].files![0])).toBe("attachment bytes");
  expect(restored).toHaveBeenCalledOnce();
  second.dispose();
});

it("serializes reorder/delete writes and preserves messages added while hydration is pending", async () => {
  await writeQueuedMessages("owner", [message("a"), message("b")]);
  const current = store();
  const persistence = persistMessageQueue({
    store: current,
    scope: () => "owner",
    reportError: vi.fn(),
  });
  current.setState({ queuedMessages: [message("new")] });
  await persistence.settled();
  expect(current.getState().queuedMessages.map((row) => row.queueId)).toEqual(["a", "b", "new"]);
  current.setState({ queuedMessages: [message("b"), message("a")] });
  current.setState({ queuedMessages: [message("a")] });
  current.setState({ queuedMessages: [] });
  await persistence.settled();
  expect(await readQueuedMessages("owner")).toEqual([]);
  persistence.dispose();
});

it("rejects late restore from another identity and keeps server/account scopes separate", async () => {
  await writeQueuedMessages("server-a/alice", [message("alice")]);
  await writeQueuedMessages("server-a/bob", [message("bob")]);
  await writeQueuedMessages("server-b/bob", [message("other-server")]);
  let scope = "server-a/alice";
  const current = store();
  const persistence = persistMessageQueue({
    store: current,
    scope: () => scope,
    reportError: vi.fn(),
  });
  scope = "server-a/bob";
  persistence.refreshScope();
  await persistence.settled();
  expect(current.getState().queuedMessages.map((row) => row.queueId)).toEqual(["bob"]);
  scope = "server-b/bob";
  persistence.refreshScope();
  await persistence.settled();
  expect(current.getState().queuedMessages.map((row) => row.queueId)).toEqual(["other-server"]);
  expect((await readQueuedMessages("server-a/alice"))[0].queueId).toBe("alice");
  persistence.dispose();
});

it("reports unavailable persistence while retaining the in-memory queue", async () => {
  vi.stubGlobal("indexedDB", {
    open: () => {
      throw new Error("Storage denied");
    },
  });
  const current = store([message("kept")]);
  const error = vi.fn();
  const persistence = persistMessageQueue({
    store: current,
    scope: () => "owner",
    reportError: error,
  });
  await persistence.settled();
  expect(error).toHaveBeenCalledOnce();
  expect(current.getState().queuedMessages[0].queueId).toBe("kept");
  persistence.dispose();
});

it("keeps unread files and rejects saving after failed hydration becomes writable", async () => {
  await writeQueuedMessages("owner", [
    { ...message("old"), files: [new File(["old bytes"], "old.txt")] },
  ]);
  const database = indexedDB;
  vi.stubGlobal("indexedDB", {
    open: () => {
      throw new Error("Read denied");
    },
  });
  const current = store();
  const error = vi.fn();
  const persistence = persistMessageQueue({
    store: current,
    scope: () => "owner",
    reportError: error,
  });
  await persistence.settled();
  vi.stubGlobal("indexedDB", database);
  const local = { ...message("new"), files: [new File(["local bytes"], "new.txt")] };
  current.setState({ queuedMessages: [local] });
  await expect(persistence.saved()).rejects.toThrow("Read denied");
  const saved = await readQueuedMessages("owner");
  expect(saved.map((row) => row.queueId)).toEqual(["old"]);
  expect(await contents(saved[0].files![0])).toBe("old bytes");
  expect(current.getState().queuedMessages).toEqual([local]);
  expect(error).toHaveBeenCalledOnce();
  persistence.dispose();
});

it("atomically preserves unrelated clients' files, removals and local FIFO changes", async () => {
  const first = store();
  const second = store();
  const leases = [first, second].map((client) =>
    persistMessageQueue({ store: client, scope: () => "owner", reportError: vi.fn() }),
  );
  await Promise.all(leases.map((lease) => lease.saved()));
  first.setState({
    queuedMessages: [
      { ...message("a"), files: [new File(["first bytes"], "same.txt")] },
      message("b"),
    ],
  });
  second.setState({
    queuedMessages: [
      {
        ...message("other"),
        conversationId: "other-chat",
        files: [new File(["other bytes"], "same.txt")],
      },
    ],
  });
  await Promise.all(leases.map((lease) => lease.saved()));
  expect((await readQueuedMessages("owner")).map((row) => row.queueId).sort()).toEqual([
    "a",
    "b",
    "other",
  ]);
  first.setState({ queuedMessages: [...first.getState().queuedMessages].reverse() });
  await leases[0].saved();
  let saved = await readQueuedMessages("owner");
  expect(saved.filter((row) => row.conversationId === "chat-a").map((row) => row.queueId)).toEqual([
    "b",
    "a",
  ]);
  expect(await contents(saved.find((row) => row.queueId === "a")!.files![0])).toBe("first bytes");
  expect(await contents(saved.find((row) => row.queueId === "other")!.files![0])).toBe(
    "other bytes",
  );
  first.setState({ queuedMessages: [] });
  await leases[0].saved();
  second.setState({ queuedMessages: [...second.getState().queuedMessages, message("later")] });
  await leases[1].saved();
  saved = await readQueuedMessages("owner");
  expect(saved.map((row) => row.queueId).sort()).toEqual(["later", "other"]);
  leases.forEach((lease) => lease.dispose());
});

it("does not resurrect a remote deletion when a stale client saves an unrelated edit", async () => {
  await writeQueuedMessages("owner", [message("removed"), message("kept")]);
  const first = store();
  const second = store();
  const leases = [first, second].map((client) =>
    persistMessageQueue({ store: client, scope: () => "owner", reportError: vi.fn() }),
  );
  await Promise.all(leases.map((lease) => lease.saved()));
  first.setState({
    queuedMessages: first.getState().queuedMessages.filter((row) => row.queueId !== "removed"),
  });
  await leases[0].saved();
  second.setState({
    queuedMessages: second
      .getState()
      .queuedMessages.map((row) => (row.queueId === "kept" ? { ...row, text: "new text" } : row)),
  });
  await leases[1].saved();
  expect((await readQueuedMessages("owner")).map((row) => [row.queueId, row.text])).toEqual([
    ["kept", "new text"],
  ]);
  second.setState({
    queuedMessages: second
      .getState()
      .queuedMessages.map((row) =>
        row.queueId === "removed" ? { ...row, text: "stale changed text" } : row,
      ),
  });
  await expect(leases[1].saved()).rejects.toThrow("removed by another client");
  expect((await readQueuedMessages("owner")).map((row) => row.queueId)).toEqual(["kept"]);
  expect(second.getState().queuedMessages[0].text).toBe("stale changed text");
  leases.forEach((lease) => lease.dispose());
});

it.each(["server-a/bob", "server-b/alice"])(
  "finishes outgoing hydration edits and files privately when switching to %s",
  async (other) => {
    const alice = "server-a/alice";
    await writeQueuedMessages(alice, [message("old")]);
    let scope = alice;
    const current = store();
    const persistence = persistMessageQueue({
      store: current,
      scope: () => scope,
      reportError: vi.fn(),
    });
    const local = { ...message("new"), files: [new File(["edited bytes"], "new.txt")] };
    current.setState({ queuedMessages: [local] });
    scope = other;
    persistence.refreshScope();
    expect(current.getState().queuedMessages).toEqual([]);
    await persistence.saved();
    expect(current.getState().queuedMessages).toEqual([]);
    expect(await readQueuedMessages(other)).toEqual([]);
    scope = alice;
    persistence.refreshScope();
    await persistence.saved();
    expect(current.getState().queuedMessages.map((row) => row.queueId)).toEqual(["old", "new"]);
    expect(await contents(current.getState().queuedMessages[1].files![0])).toBe("edited bytes");
    persistence.dispose();
  },
);

it("retains removed items and reordering through immediate return during hydration", async () => {
  const original = [message("a"), message("b"), message("remove")];
  await writeQueuedMessages("alice", original);
  let scope = "alice";
  const current = store(original);
  const persistence = persistMessageQueue({
    store: current,
    scope: () => scope,
    reportError: vi.fn(),
  });
  current.setState({ queuedMessages: [original[1], original[0]] });
  scope = "bob";
  persistence.refreshScope();
  scope = "alice";
  persistence.refreshScope();
  await persistence.saved();
  expect(current.getState().queuedMessages.map((row) => row.queueId)).toEqual(["b", "a"]);
  expect((await readQueuedMessages("alice")).map((row) => row.queueId)).toEqual(["b", "a"]);
  expect(await readQueuedMessages("bob")).toEqual([]);
  persistence.dispose();
});

it("retains failed-hydration edits privately until an explicit return can read and merge", async () => {
  await writeQueuedMessages("alice", [message("old")]);
  const database = indexedDB;
  vi.stubGlobal("indexedDB", {
    open: () => {
      throw new Error("Offline");
    },
  });
  let scope = "alice";
  const current = store();
  const persistence = persistMessageQueue({
    store: current,
    scope: () => scope,
    reportError: vi.fn(),
  });
  await persistence.settled();
  current.setState({
    queuedMessages: [{ ...message("new"), files: [new File(["local bytes"], "new.txt")] }],
  });
  scope = "bob";
  persistence.refreshScope();
  await persistence.settled();
  expect(current.getState().queuedMessages).toEqual([]);
  vi.stubGlobal("indexedDB", database);
  scope = "alice";
  persistence.refreshScope();
  await persistence.saved();
  expect(current.getState().queuedMessages.map((row) => row.queueId)).toEqual(["old", "new"]);
  expect(await contents(current.getState().queuedMessages[1].files![0])).toBe("local bytes");
  expect(await readQueuedMessages("bob")).toEqual([]);
  persistence.dispose();
});

it("keeps a late outgoing file failure with its owner and saves the new identity successfully", async () => {
  let scope = "alice";
  const current = store();
  const report = vi.fn();
  const persistence = persistMessageQueue({
    store: current,
    scope: () => scope,
    reportError: report,
  });
  await persistence.saved();
  let fail: (error: Error) => void = () => {
    throw new Error("No pending file read");
  };
  let started: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const file = new File(["bytes"], "local.txt");
  Object.defineProperty(file, "arrayBuffer", {
    value: () =>
      new Promise((_resolve, reject) => {
        fail = reject;
        started();
      }),
  });
  current.setState({ queuedMessages: [{ ...message("local"), files: [file] }] });
  await reading;
  const oldSave = persistence.saved();
  scope = "bob";
  persistence.refreshScope();
  fail(new Error("Attachment read failed"));
  await expect(oldSave).rejects.toThrow("identity changed");
  await persistence.saved();
  expect(report).not.toHaveBeenCalled();
  expect(current.getState().queuedMessages).toEqual([]);
  scope = "alice";
  persistence.refreshScope();
  expect(current.getState().queuedMessages[0].files).toEqual([file]);
  current.setState({
    queuedMessages: [
      { ...message("local"), files: [new File(["replacement bytes"], "fixed.txt")] },
    ],
  });
  await persistence.saved();
  expect((await readQueuedMessages("alice"))[0].files?.[0].name).toBe("fixed.txt");
  expect(await readQueuedMessages("bob")).toEqual([]);
  persistence.dispose();
});

it("persists synchronous consumer edits made while restored state is published", async () => {
  await writeQueuedMessages("owner", [message("old")]);
  const current = store();
  const unsubscribe = current.subscribe((state) => {
    if (
      state.queuedMessages.some((row) => row.queueId === "old") &&
      !state.queuedMessages.some((row) => row.queueId === "nested")
    )
      current.setState({ queuedMessages: [...state.queuedMessages, message("nested")] });
  });
  const persistence = persistMessageQueue({
    store: current,
    scope: () => "owner",
    reportError: vi.fn(),
  });
  await persistence.saved();
  expect(current.getState().queuedMessages.map((row) => row.queueId)).toEqual(["old", "nested"]);
  expect((await readQueuedMessages("owner")).map((row) => row.queueId)).toEqual(["old", "nested"]);
  unsubscribe();
  persistence.dispose();
});
