// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { describe, expect, it } from "vitest";
import { itemsToBlocks } from "./itemsToBlocks";
import { buildBubbles, mergePlacedPendingBubbles, type Bubble } from "./renderItems";
import {
  normalizeTranscript,
  replaceNativePreviewContent,
  orderTranscriptBlocks,
  projectPendingTranscript,
  projectionStructureStamp,
  transcriptIndex,
  type TranscriptAnchor,
} from "./transcriptOrder";
import type { AnyBlock, TextDone } from "./blocks";
import type { MessageItem } from "./conversationItems";

const item = (id: string, position: number): MessageItem => ({
  id,
  position,
  type: "message",
  role: "assistant",
  status: "completed",
  response_id: id,
  phase: "final_answer",
  content: [{ type: "output_text", text: id }],
});
const preview = (id: string): TextDone => ({
  type: "text_done",
  ctx: { agent: null, depth: 0, timestamp: 0, turn: 0, responseId: id, itemId: `live:${id}` },
  fullText: id,
  hasCodeBlocks: false,
});

describe("canonical order and provisional placement", () => {
  it("reuses immutable indexes and discovery stamps only for placed native preview content", () => {
    const history = itemsToBlocks([
      item("a1", 0),
      {
        id: "call",
        position: 1,
        type: "function_call",
        status: "completed",
        response_id: "turn",
        name: "read",
        call_id: "call-id",
        arguments: "{}",
      },
    ]);
    const placed = normalizeTranscript(
      { blocks: history, pendingUserMessages: [] },
      { blocks: [...history, preview("answer")], pendingUserMessages: [] },
    ).blocks;
    const oldIndex = transcriptIndex(placed);
    const oldStamp = projectionStructureStamp(placed);
    expect(projectionStructureStamp(placed)).toBe(oldStamp);
    expect(Object.isFrozen(oldStamp)).toBe(true);
    expect(Reflect.ownKeys(oldStamp)).toEqual([]);
    const oldEntries = [...oldIndex.items];
    const oldTools = [...oldIndex.tools];
    const original = placed.at(-1)! as TextDone;
    const changes = new Map([
      [
        placed.length - 1,
        {
          fullText: "Answer [source](https://example.invalid/source) ```ts",
          hasCodeBlocks: true,
          streamIndex: 9,
          previewInterrupted: true,
        },
      ],
    ]);
    const next = replaceNativePreviewContent(placed, { base: placed, changes })!;
    expect(next).not.toBe(placed);
    expect(next.slice(0, -1)).toEqual(history);
    expect(next[0]).toBe(history[0]);
    expect(next.at(-1)).toMatchObject(changes.get(placed.length - 1)!);
    expect(next.at(-1)!.ctx).toBe(original.ctx);
    expect(original.fullText).toBe("answer");
    expect(transcriptIndex(next)).toBe(oldIndex);
    expect(projectionStructureStamp(next)).toBe(oldStamp);
    expect([...oldIndex.items]).toEqual(oldEntries);
    expect([...oldIndex.tools]).toEqual(oldTools);
    expect(oldIndex.tools.get("call-id")).toBe(1);
    const appended = normalizeTranscript(
      { blocks: next, pendingUserMessages: [] },
      { blocks: [...next, ...itemsToBlocks([item("a2", 2)])], pendingUserMessages: [] },
    ).blocks;
    expect(transcriptIndex(appended)).not.toBe(oldIndex);
    expect(projectionStructureStamp(appended)).not.toBe(oldStamp);
    expect(transcriptIndex(appended).items.get("a2")).toBeDefined();
    expect(oldIndex.items.has("a2")).toBe(false);
    expect(replaceNativePreviewContent(appended, { base: next, changes })).toBeNull();
  });

  it("rejects committed, unplaced or stale-base content operations", () => {
    const committed = itemsToBlocks([item("a1", 0)]);
    const unplaced = [preview("answer")];
    const changes = new Map([[0, { fullText: "replacement", hasCodeBlocks: false }]]);
    expect(replaceNativePreviewContent(committed, { base: committed, changes })).toBeNull();
    expect(replaceNativePreviewContent(unplaced, { base: unplaced, changes })).toBeNull();
    const placed = normalizeTranscript(
      { blocks: committed, pendingUserMessages: [] },
      { blocks: [...committed, ...unplaced], pendingUserMessages: [] },
    ).blocks;
    const stale = { base: placed, changes: new Map([[1, changes.get(0)!]]) };
    const copied = placed.slice();
    const stamp = projectionStructureStamp(placed);
    expect(replaceNativePreviewContent(copied, stale)).toBeNull();
    expect(projectionStructureStamp(copied)).not.toBe(stamp);
    expect(replaceNativePreviewContent(placed, { base: placed, changes: new Map() })).toBeNull();
    expect(projectionStructureStamp(placed)).toBe(stamp);
  });

  it("gives filtered, pending-projected and general replacement arrays their own discovery stamp", () => {
    const blocks = itemsToBlocks([item("a1", 0), item("a2", 1)]);
    const stamp = projectionStructureStamp(blocks);
    const pending = projectPendingTranscript(
      blocks,
      [{ tempId: "pending", position: 2, content: [{ type: "input_text", text: "Next" }] }],
      null,
    );
    const edited = blocks.map((block, at) =>
      at === 0 && block.type === "text_done" ? { ...block, fullText: "Edited" } : block,
    );
    for (const general of [blocks.slice(), blocks.filter((_, at) => at > 0), pending, edited]) {
      expect(projectionStructureStamp(general)).not.toBe(stamp);
      expect(projectionStructureStamp(general)).toBe(projectionStructureStamp(general));
    }
    expect(projectPendingTranscript(blocks, [], null)).toBe(blocks);
  });

  it("keeps canonical order when an identified live record still lacks its saved position", () => {
    const a1 = itemsToBlocks([item("a1", 1)])[0]!;
    const a2 = itemsToBlocks([item("a2", 3)])[0]!;
    const q2 = itemsToBlocks([item("q2", 2)])[0]!;
    const legacy = { ...preview("tool"), ctx: { ...preview("tool").ctx, itemId: "tool-id" } };
    const live = normalizeTranscript(
      { blocks: [a1], pendingUserMessages: [] },
      { blocks: [a1, legacy], pendingUserMessages: [] },
    );
    expect(live.blocks[1]!.ctx.anchor?.afterItemId).toBe("a1");
    const settled = normalizeTranscript(live, {
      blocks: [...live.blocks, a2, q2],
      pendingUserMessages: [],
    });
    expect(settled.blocks.map((block) => block.ctx.itemId)).toEqual(["a1", "tool-id", "q2", "a2"]);
  });

  it("repairs an existing committed inversion while retaining canonical phase and item identity", () => {
    const blocks = itemsToBlocks([item("a2", 3), item("a1", 1)]);
    const sorted = orderTranscriptBlocks([...blocks].reverse());
    expect(sorted.map((block) => block.ctx.itemId)).toEqual(["a1", "a2"]);
    expect(
      sorted.every((block) => block.type === "text_done" && block.phase === "final_answer"),
    ).toBe(true);
    expect(orderTranscriptBlocks(sorted)).toBe(sorted);
    expect(transcriptIndex(sorted).items.get("a2")).toBe(1);
  });

  it("keeps a pending question above early output and reanchors the output at promotion", () => {
    const committed = itemsToBlocks([item("a1", 1)]);
    const pending: { tempId: string; content: MessageItem["content"]; anchor?: TranscriptAnchor } =
      { tempId: "local-question", content: [{ type: "input_text", text: "Question" }] };
    const before = normalizeTranscript(
      { blocks: committed, pendingUserMessages: [] },
      { blocks: committed, pendingUserMessages: [pending] },
    );
    const live = normalizeTranscript(before, {
      ...before,
      blocks: [...before.blocks, preview("answer")],
    });
    const pendingBubble: Bubble = {
      kind: "user",
      itemId: pending.tempId,
      pending: true,
      content: pending.content,
      anchor: live.pendingUserMessages[0]!.anchor,
    };
    const bubbles = mergePlacedPendingBubbles(
      buildBubbles(projectPendingTranscript(live.blocks, live.pendingUserMessages, null), null),
      [pendingBubble],
    );
    expect(bubbles.map((bubble) => bubble.kind)).toEqual(["assistant", "user", "assistant"]);
    const question: AnyBlock = {
      type: "user_message",
      stableKey: pending.tempId,
      content: pending.content,
      ctx: { ...committed[0]!.ctx, responseId: "turn2", itemId: "question", position: 2 },
    };
    const promoted = normalizeTranscript(live, {
      blocks: [...live.blocks, question],
      pendingUserMessages: [],
    });
    expect(promoted.blocks.map((block) => block.ctx.itemId)).toEqual([
      "a1",
      "question",
      "live:answer",
    ]);
  });

  it("places a saved pending peer receipt by its original canonical slot with exact dedup", () => {
    const blocks = itemsToBlocks([item("a1", 150), item("a2", 152)]);
    const peer: Bubble = {
      kind: "user",
      itemId: "peer-receipt",
      pending: true,
      position: 151,
      content: [{ type: "input_text", text: "Peer request" }],
    };
    const committed = buildBubbles(
      projectPendingTranscript(
        blocks,
        [{ tempId: "peer-receipt", itemId: "peer-receipt", position: 151, content: peer.content }],
        null,
      ),
      null,
    );
    const projected = mergePlacedPendingBubbles(committed, [peer]);
    expect(projected.map((bubble) => bubble.position)).toEqual([150, 151, 152]);
    expect(mergePlacedPendingBubbles(projected, [peer])).toEqual(projected);
  });

  it("keeps itemless boundaries and local sequence despite skewed clock stamps", () => {
    const committed = itemsToBlocks([item("a1", 1), item("a2", 2)]);
    const first = {
      ...preview("first"),
      ctx: {
        ...preview("first").ctx,
        itemId: null,
        clientCreatedAtS: -100000,
        anchor: { afterItemId: "a1", afterPosition: 1, sequence: 1 },
      },
    };
    const second = {
      ...preview("second"),
      ctx: {
        ...preview("second").ctx,
        itemId: null,
        createdAtS: 99999999,
        anchor: { afterItemId: "a1", afterPosition: 1, sequence: 2 },
      },
    };
    const sorted = orderTranscriptBlocks([committed[1]!, second, committed[0]!, first]);
    expect(sorted.map((block) => (block.type === "text_done" ? block.fullText : ""))).toEqual([
      "a1",
      "first",
      "second",
      "a2",
    ]);
  });
});
