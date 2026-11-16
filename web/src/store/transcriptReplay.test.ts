// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import type { AnyBlock, TextDone } from "@/lib/blocks";
import type { MessageItem } from "@/lib/conversationItems";
import type { StreamEvent } from "@/lib/events";
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
const sync = (phase: "start" | "complete", itemCount: number): StreamEvent => ({
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

it("does not delete loaded history on a partial or incomplete reset", () => {
  const current = itemsToBlocks([message("saved", 0, "Keep loaded history")]);
  const replay = new TranscriptReplay();
  expect(replay.accept(sync("start", 2), current)).toBeNull();
  expect(
    replay.accept(
      {
        type: "session_item_updated",
        item: { ...message("other", 1, "Partial") },
        committedItem: { ...message("other", 1, "Partial") },
      },
      current,
    ),
  ).toBeNull();
  expect(replay.accept(sync("complete", 2), current)).toBeNull();
  expect(current[0]).toMatchObject({ fullText: "Keep loaded history" });
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
