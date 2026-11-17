// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { LIVE_ITEM_PREFIX, type AnyBlock } from "@/lib/blocks";
import { preserveInputAttachments, type ConversationItem } from "@/lib/conversationItems";
import type { StreamEvent } from "@/lib/events";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import { isCommittedBlock, orderTranscriptBlocks } from "@/lib/transcriptOrder";

/** Replace authoritative membership while preserving local inputs, anchors and exact preview identity. */
export function replaceCanonicalTranscript(
  current: AnyBlock[],
  items: ConversationItem[],
): AnyBlock[] {
  const oldUsers = new Map(
    current.flatMap((block) =>
      block.type === "user_message" && block.ctx.itemId ? [[block.ctx.itemId, block] as const] : [],
    ),
  );
  const canonical = itemsToBlocks(items).map((block) => {
    const old = block.ctx.itemId ? oldUsers.get(block.ctx.itemId) : undefined;
    return old && block.type === "user_message"
      ? {
          ...block,
          content: preserveInputAttachments(block.content, old.stableKey ? old.content : null),
          ...((block.inputStableId ?? old.inputStableId)
            ? { inputStableId: block.inputStableId ?? old.inputStableId }
            : {}),
          ...(old.stableKey ? { stableKey: old.stableKey } : {}),
          ctx: {
            ...block.ctx,
            ...(old.ctx.clientCreatedAtS !== undefined
              ? { clientCreatedAtS: old.ctx.clientCreatedAtS }
              : {}),
            ...(old.ctx.aliases
              ? { aliases: [...new Set([...(block.ctx.aliases ?? []), ...old.ctx.aliases])] }
              : {}),
          },
        }
      : block;
  });
  const replaced = new Set(
    items.flatMap((item) => [
      item.id,
      ...("stream_message_id" in item && typeof item.stream_message_id === "string"
        ? [LIVE_ITEM_PREFIX + item.stream_message_id]
        : []),
    ]),
  );
  const overlays = current.filter(
    (block) => !isCommittedBlock(block) && (!block.ctx.itemId || !replaced.has(block.ctx.itemId)),
  );
  return orderTranscriptBlocks([...canonical, ...overlays]);
}

/** A later saved version updates the same identity, including phase and source metadata. */
export function upsertCanonicalItem(current: AnyBlock[], item: ConversationItem): AnyBlock[] {
  const replacements = replaceCanonicalTranscript(
    current.filter((block) => block.ctx.itemId === item.id),
    [item],
  );
  const at = current.findIndex((block) => block.ctx.itemId === item.id);
  if (at === -1) return orderTranscriptBlocks([...current, ...replacements]);
  const kept = current.filter((block) => block.ctx.itemId !== item.id);
  return orderTranscriptBlocks([...kept.slice(0, at), ...replacements, ...kept.slice(at)]);
}

/** Each transport attempt stages resets until complete; a dropped partial replay cannot delete history. */
export class TranscriptReplay {
  private items: Map<string, ConversationItem> | null = null;

  accept(event: StreamEvent, current: AnyBlock[]): AnyBlock[] | null {
    if (event.type === "session_sync" && event.phase === "start" && event.reset) {
      this.items = new Map();
      return null;
    }
    if (this.items && event.committedItem && typeof event.committedItem.id === "string")
      this.items.set(event.committedItem.id, event.committedItem as ConversationItem);
    if (event.type !== "session_sync" || event.phase !== "complete" || !this.items) return null;
    const items = [...this.items.values()];
    this.items = null;
    if (items.length !== event.itemCount) return null;
    return replaceCanonicalTranscript(current, items);
  }
}
