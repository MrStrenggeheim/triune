// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { AnyBlock } from "./blocks";
import type { ConversationBranch } from "./conversationBranches";

export const SUBCHAT_HISTORY_LABEL = "omnigent.subchat.inherited_last_item_id";
export const QUOTE_SUBCHAT_HISTORY_LABEL = "omnigent.subchat.quote_source_item_id";

/** Copied labels must not silently change an explicit fork's history preference. */
export function shouldHideSubchatHistory(
  labels?: Record<string, string | null> | null,
  branch?: ConversationBranch | null,
): boolean {
  return Boolean(
    ((branch?.inherited_last_item_id &&
      labels?.[SUBCHAT_HISTORY_LABEL] === branch.inherited_last_item_id) ||
      (labels?.["omnigent.side_chat"] === "1" &&
        branch?.source_conversation_id &&
        branch.source_conversation_id ===
          (labels["omnigent.side_chat.source_id"] ?? labels["omnigent.fork.source_id"])) ||
      (branch?.source_item_id &&
        labels?.[QUOTE_SUBCHAT_HISTORY_LABEL] === branch.source_item_id)) &&
    hasInheritedHistory(branch),
  );
}

/** Split before bubble grouping, since a response may span the fork boundary. */
export function inheritedHistoryEnd(
  blocks: readonly AnyBlock[],
  branch?: ConversationBranch | null,
): number {
  if (!branch?.inherited_last_item_id) return -1;
  return blocks.findLastIndex((block) => block.ctx.itemId === branch.inherited_last_item_id);
}

export function hasInheritedHistory(branch?: ConversationBranch | null): boolean {
  return !!(branch && branch.inherited_last_item_id && branch.inherited_item_count !== 0);
}
