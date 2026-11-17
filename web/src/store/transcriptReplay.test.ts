// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import type { AnyBlock, TextDone } from "@/lib/blocks";
import type { ConversationItem, MessageItem } from "@/lib/conversationItems";
import type { SessionSyncEvent, StreamEvent } from "@/lib/events";
import {
  TranscriptReplay,
  replaceCanonicalTranscript,
  upsertCanonicalItem,
} from "./transcriptReplay";

const message = (id: string, position: number, text: string): MessageItem => ({
  id,
  position,
  type: "message",
  role: "assistant",
  response_id: "turn",
  status: "completed",
  content: [{ type: "output_text", text }],
  phase: "final_answer",
});
const sync = (phase: "start" | "complete", itemCount: number): SessionSyncEvent => ({
  type: "session_sync",
  phase,
  reset: true,
  lastPosition: itemCount - 1,
  lastItemId: "saved",
  itemCount,
  streamEpoch: "epoch",
  itemRevision: 10,
  resetRevision: 10,
});

const committed = (item: ConversationItem): StreamEvent => ({
  type: "session_item_updated",
  item: item as unknown as Record<string, unknown>,
  committedItem: item as unknown as Record<string, unknown>,
});

const windowSync = (
  phase: "start" | "complete",
  overrides: Partial<SessionSyncEvent> = {},
): SessionSyncEvent => ({
  ...sync(phase, 12),
  lastPosition: 11,
  windowStartPosition: 8,
  windowItemCount: 3,
  hasOlderItems: true,
  firstItemId: "hidden",
  ...overrides,
});

it("does not delete loaded history on a partial or incomplete reset", () => {
  const current = itemsToBlocks([message("saved", 0, "Keep loaded history")]);
  const replay = new TranscriptReplay();
  expect(replay.accept(sync("start", 2), current)).toBeNull();
  expect(replay.accept(committed(message("other", 1, "Partial")), current)).toBeNull();
  expect(replay.accept(sync("complete", 2), current)).toBeNull();
  expect(current[0]).toMatchObject({ fullText: "Keep loaded history" });
});

it("accepts an empty requested window beyond an empty captured tail", () => {
  const current = itemsToBlocks([message("future", 0, "Arrived after capture")]);
  const replay = new TranscriptReplay();
  const empty = (phase: "start" | "complete"): SessionSyncEvent => ({
    ...sync(phase, 0),
    lastItemId: null,
    windowStartPosition: 0,
    windowItemCount: 0,
    hasOlderItems: false,
    firstItemId: null,
  });
  replay.accept(empty("start"), current);
  replay.accept(committed(message("future", 0, "Arrived after capture")), current);
  const next = replay.accept(empty("complete"), current);
  expect(replay.checkpointAccepted).toBe(true);
  expect(next?.map((block) => block.ctx.itemId)).toEqual(["future"]);
});

it("limits a nonwindow reset to captured high water and preserves its live tail", () => {
  const current = itemsToBlocks([
    message("obsolete", 0, "Drop inside captured range"),
    message("future", 2, "Keep live tail"),
    message("stale-future", 3, "Drop unobserved stale row"),
  ]);
  const replay = new TranscriptReplay();
  replay.accept(sync("start", 1), current);
  replay.accept(committed(message("saved", 0, "Authoritative")), current);
  replay.accept(committed(message("future", 2, "Keep live tail")), current);
  const next = replay.accept(sync("complete", 1), current)!;
  expect(next.map((block) => block.ctx.itemId)).toEqual(["saved", "future"]);
});

it("exposes reset staging and atomically replaces only the validated window", () => {
  const current = itemsToBlocks([
    message("older", 2, "Older"),
    message("stale", 9, "Stale"),
    message("future", 14, "Future"),
  ]);
  const replay = new TranscriptReplay();
  expect(replay.isResetting).toBe(false);
  replay.accept(windowSync("start"), current);
  expect(replay.isResetting).toBe(true);
  const hidden: ConversationItem = {
    id: "hidden",
    position: 8,
    type: "summary",
    response_id: "turn",
    status: "completed",
  };
  replay.accept(committed(hidden), current);
  replay.accept(committed(message("fresh", 10, "Fresh")), current);
  replay.accept(committed(message("last", 11, "Last")), current);
  const next = replay.accept(windowSync("complete"), current)!;
  expect(replay.isResetting).toBe(false);
  expect(replay.checkpointAccepted).toBe(true);
  // Hidden canonical metadata counts toward membership without rendering a block.
  expect(next.map((block) => block.ctx.itemId)).toEqual(["older", "fresh", "last", "future"]);
});

it.each([
  ["missing", [message("hidden", 8, "A"), message("last", 11, "C")]],
  ["reordered", [message("last", 11, "C"), message("hidden", 8, "A"), message("fresh", 10, "B")]],
  [
    "duplicate position",
    [message("hidden", 8, "A"), message("fresh", 8, "B"), message("last", 11, "C")],
  ],
])("fails closed for %s reset membership", (_name, staged) => {
  const current = itemsToBlocks([message("stale", 9, "Keep")]);
  const replay = new TranscriptReplay();
  replay.accept(windowSync("start"), current);
  for (const item of staged) replay.accept(committed(item), current);
  expect(replay.accept(windowSync("complete"), current)).toBeNull();
  expect(replay.checkpointAccepted).toBe(false);
  expect(current[0]).toMatchObject({ fullText: "Keep" });
});

it("deduplicates identical retry frames but rejects conflicting duplicate identities", () => {
  const current = itemsToBlocks([message("stale", 9, "Keep")]);
  const valid = new TranscriptReplay();
  valid.accept(windowSync("start", { windowItemCount: 1 }), current);
  const item = message("hidden", 8, "Same");
  valid.accept(committed(item), current);
  valid.accept(committed({ ...item }), current);
  expect(valid.accept(windowSync("complete", { windowItemCount: 1 }), current)).not.toBeNull();

  const conflict = new TranscriptReplay();
  conflict.accept(windowSync("start", { windowItemCount: 1 }), current);
  conflict.accept(committed(item), current);
  conflict.accept(
    committed({ ...item, content: [{ type: "output_text", text: "Changed" }] }),
    current,
  );
  expect(conflict.accept(windowSync("complete", { windowItemCount: 1 }), current)).toBeNull();
});

it("leaves committed rows outside the authoritative range on the live path", () => {
  const replay = new TranscriptReplay();
  const before = itemsToBlocks([message("older", 2, "Old value"), message("stale", 8, "Stale")]);
  replay.accept(windowSync("start", { windowItemCount: 1 }), before);
  const older = committed(message("older", 2, "Updated older value"));
  const future = committed(message("future", 12, "Live future"));
  expect(replay.stages(older)).toBe(false);
  expect(replay.stages(future)).toBe(false);
  expect(replay.accept(older, before)).toBeNull();
  expect(replay.accept(future, before)).toBeNull();

  const canonical = committed(message("hidden", 8, "Canonical"));
  expect(replay.stages(canonical)).toBe(true);
  replay.accept(canonical, before);
  const withLiveRows = itemsToBlocks([
    message("older", 2, "Updated older value"),
    message("stale", 8, "Stale"),
    message("future", 12, "Live future"),
  ]);
  const next = replay.accept(windowSync("complete", { windowItemCount: 1 }), withLiveRows)!;
  expect(next.map((block) => block.ctx.itemId)).toEqual(["older", "hidden", "future"]);
  expect(next[0]).toMatchObject({ fullText: "Updated older value" });
});

it("ignores orphan rows and rejects malformed rows or mismatched reset boundaries", () => {
  const current = itemsToBlocks([message("saved", 0, "Keep")]);
  const replay = new TranscriptReplay();
  replay.accept(committed(message("orphan", 8, "Ignore")), current);
  replay.accept(windowSync("start", { windowItemCount: 1 }), current);
  replay.accept(
    {
      ...committed(message("hidden", 8, "Bad")),
      committedItem: { id: "hidden" },
    } as StreamEvent,
    current,
  );
  expect(replay.accept(windowSync("complete", { windowItemCount: 1 }), current)).toBeNull();

  replay.accept(windowSync("start", { windowItemCount: 1 }), current);
  replay.accept(committed(message("hidden", 8, "Good")), current);
  expect(
    replay.accept(windowSync("complete", { windowItemCount: 1, streamEpoch: "other" }), current),
  ).toBeNull();
  expect(current.map((block) => block.ctx.itemId)).toEqual(["saved"]);
});

it("upserts an old-position revision and phase under the same saved ID", () => {
  const old = { ...message("saved", 0, "Progress"), phase: "commentary" as const };
  const current = itemsToBlocks([old, message("later", 1, "Later answer")]);
  const next = upsertCanonicalItem(current, message("saved", 0, "Authoritative final"));
  expect(next.map((block) => block.ctx.itemId)).toEqual(["saved", "later"]);
  expect(next[0]).toMatchObject({ fullText: "Authoritative final", phase: "final_answer" });
});

it("retains exact user key, uploads, aliases and server provenance during reset", () => {
  const saved: MessageItem = {
    ...message("human", 0, ""),
    role: "user",
    user_authored: true,
    created_by: "owner@example.test",
    content: [{ type: "input_text", text: "Prompt" }],
  };
  const current = itemsToBlocks([saved]);
  const user = current[0]!;
  expect(user.type).toBe("user_message");
  if (user.type !== "user_message") return;
  user.stableKey = "local-send";
  user.content = [{ type: "input_image", file_id: "accepted-upload" }, ...user.content];
  user.ctx.aliases = ["server-pending-handle"];
  const next = replaceCanonicalTranscript(current, [saved]);
  expect(next[0]).toMatchObject({
    stableKey: "local-send",
    userAuthored: true,
    ctx: { createdBy: "owner@example.test", aliases: ["server-pending-handle"] },
    content: [
      { type: "input_image", file_id: "accepted-upload" },
      { type: "input_text", text: "Prompt" },
    ],
  });
});

it("retains an identified provisional output until its exact saved replacement arrives", () => {
  const pending: TextDone = {
    type: "text_done",
    fullText: "Output still arriving",
    hasCodeBlocks: false,
    ctx: {
      agent: null,
      depth: 0,
      timestamp: 0,
      turn: 0,
      responseId: "turn",
      itemId: "reserved-output-id",
    },
  };
  expect(replaceCanonicalTranscript([pending], [])).toEqual([pending]);
  const next = replaceCanonicalTranscript(
    [pending],
    [message("reserved-output-id", 0, "Saved output")],
  );
  expect(next).toHaveLength(1);
  expect(next[0]!.ctx.position).toBe(0);
  expect(next[0]!.type === "text_done" && next[0]!.fullText).toBe("Saved output");
});

it("replaces only a preview named by authoritative native identity", () => {
  const preview = (id: string): TextDone => ({
    type: "text_done",
    fullText: "Same text",
    hasCodeBlocks: false,
    ctx: {
      agent: null,
      depth: 0,
      turn: 0,
      timestamp: 0,
      responseId: "turn",
      itemId: `live:${id}`,
      anchor: { afterItemId: null, afterPosition: -1, sequence: id === "one" ? 1 : 2 },
    },
  });
  const current: AnyBlock[] = [preview("one"), preview("two")];
  const next = replaceCanonicalTranscript(current, [
    { ...message("saved", 0, "Same text"), stream_message_id: "one" },
  ]);
  expect(next.map((block) => block.ctx.itemId)).toEqual(["live:two", "saved"]);
});
