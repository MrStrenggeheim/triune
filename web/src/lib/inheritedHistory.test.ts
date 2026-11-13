// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { describe, expect, it } from "vitest";
import type { AnyBlock } from "./blocks";
import type { ConversationBranch } from "./conversationBranches";
import { buildBubbles } from "./renderItems";
import {
  hasInheritedHistory,
  inheritedHistoryEnd,
  QUOTE_SUBCHAT_HISTORY_LABEL,
  shouldHideQuoteSubchatHistory,
} from "./inheritedHistory";

const branch: ConversationBranch = {
  source_conversation_id: "source",
  source_item_id: "source-last",
  inherited_last_item_id: "copied-last",
  inherited_item_count: 2,
  reference_only: false,
  recovery: "replay",
};

function text(itemId: string, fullText = "identical text"): AnyBlock {
  return {
    type: "text_done",
    ctx: { itemId, responseId: "same-response", agent: null, depth: 0, turn: 0, timestamp: 0 },
    fullText,
    hasCodeBlocks: false,
  };
}

describe("inherited history boundary", () => {
  it("hides a quote subchat whose marker matches its original source item", () => {
    expect(
      shouldHideQuoteSubchatHistory({ [QUOTE_SUBCHAT_HISTORY_LABEL]: "source-last" }, branch),
    ).toBe(true);
  });

  it("does not hide an explicit fork that copied its source subchat's marker", () => {
    expect(
      shouldHideQuoteSubchatHistory(
        { [QUOTE_SUBCHAT_HISTORY_LABEL]: "source-last" },
        { ...branch, source_item_id: "copied-last", inherited_last_item_id: "fork-last" },
      ),
    ).toBe(false);
  });

  it("uses the copied boundary ID and keeps identically worded child output", () => {
    const blocks = [text("old"), text("copied-last"), text("child")];
    const end = inheritedHistoryEnd(blocks, branch);
    expect(end).toBe(1);
    expect(buildBubbles(blocks.slice(end + 1), null)).toMatchObject([
      { kind: "assistant", items: [{ itemId: "child", text: "identical text" }] },
    ]);
    expect(blocks).toHaveLength(3);
    expect(buildBubbles(blocks, null)[0]).toMatchObject({
      items: [{ itemId: "old" }, { itemId: "copied-last" }, { itemId: "child" }],
    });
  });

  it("includes every block from the boundary item in inherited history", () => {
    const blocks = [text("copied-last"), text("copied-last"), text("child")];
    expect(inheritedHistoryEnd(blocks, branch)).toBe(1);
  });

  it("keeps a child-only loaded page visible and finds the boundary after paging older", () => {
    const recent = [text("child")];
    expect(inheritedHistoryEnd(recent, branch)).toBe(-1);
    const prepended = [text("old"), text("copied-last"), ...recent];
    expect(prepended.slice(inheritedHistoryEnd(prepended, branch) + 1)).toEqual(recent);
  });

  it("does not infer inherited items from a count or a source ID", () => {
    const legacy = { ...branch, inherited_last_item_id: null };
    expect(hasInheritedHistory(legacy)).toBe(false);
    expect(inheritedHistoryEnd([text("source-last"), text("child")], legacy)).toBe(-1);
  });

  it("does not fold empty or reference-only branches", () => {
    expect(hasInheritedHistory({ ...branch, inherited_item_count: 0 })).toBe(false);
    expect(hasInheritedHistory({ ...branch, reference_only: true })).toBe(false);
    expect(inheritedHistoryEnd([text("copied-last")], { ...branch, reference_only: true })).toBe(
      -1,
    );
    expect(hasInheritedHistory()).toBe(false);
    expect(hasInheritedHistory(branch)).toBe(true);
  });
});
