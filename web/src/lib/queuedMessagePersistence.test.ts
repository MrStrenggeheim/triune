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
