// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { LIVE_ITEM_PREFIX, type AnyBlock } from "@/lib/blocks";
import { preserveInputAttachments, type ConversationItem } from "@/lib/conversationItems";
import type { SessionSyncEvent, StreamEvent } from "@/lib/events";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import { isCommittedBlock, itemPosition, orderTranscriptBlocks } from "@/lib/transcriptOrder";

/** Replace authoritative membership while preserving local inputs, anchors and exact preview identity. */
export function replaceCanonicalTranscript(
  current: AnyBlock[],
  items: ConversationItem[],
  range?: { start: number; end: number },
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
  const overlays = current.filter((block) => {
    if (block.ctx.itemId && replaced.has(block.ctx.itemId)) return false;
    if (!isCommittedBlock(block)) return true;
    return (
      range !== undefined && (block.ctx.position! < range.start || block.ctx.position! > range.end)
    );
  });
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
  private boundary: SessionSyncEvent | null = null;
  private invalid = false;
  private lastStagedPosition: number | undefined;
  private liveTailIds = new Set<string>();
  checkpointAccepted = false;

  get isResetting(): boolean {
    return this.items !== null;
  }

  /** Whether a committed row belongs to the active reset rather than ordinary live processing. */
  stages(event: StreamEvent): boolean {
    if (!this.items || !this.boundary || !("committedItem" in event) || !event.committedItem)
      return false;
    const position = itemPosition(event.committedItem.position);
    if (position === undefined) return true;
    return (
      position <= this.boundary.lastPosition &&
      (this.boundary.windowStartPosition === undefined ||
        position >= this.boundary.windowStartPosition)
    );
  }

  accept(event: StreamEvent, current: AnyBlock[]): AnyBlock[] | null {
    this.checkpointAccepted = false;
    if (event.type === "session_sync" && event.phase === "start") {
      this.boundary = event;
      this.items = event.reset ? new Map() : null;
      this.invalid = event.reset && !validResetBoundary(event);
      this.lastStagedPosition = undefined;
      this.liveTailIds.clear();
      return null;
    }
    const stagedItems = this.items;
    if (
      stagedItems &&
      this.boundary !== null &&
      this.boundary.windowStartPosition === undefined &&
      !this.stages(event) &&
      "committedItem" in event &&
      event.committedItem &&
      typeof event.committedItem.id === "string" &&
      itemPosition(event.committedItem.position)! > this.boundary.lastPosition
    )
      this.liveTailIds.add(event.committedItem.id);
    if (
      stagedItems &&
      this.stages(event) &&
      "committedItem" in event &&
      event.committedItem !== undefined
    ) {
      const item = event.committedItem as ConversationItem;
      const position = itemPosition(item?.position);
      if (!item || typeof item.id !== "string" || !item.id || position === undefined) {
        this.invalid = true;
      } else {
        const existing = stagedItems.get(item.id);
        if (existing) {
          // Transport retries may repeat a frame, but an identity cannot change within a reset.
          if (stableValue(existing) !== stableValue(item)) this.invalid = true;
        } else {
          if (this.lastStagedPosition !== undefined && position <= this.lastStagedPosition)
            this.invalid = true;
          stagedItems.set(item.id, item);
          this.lastStagedPosition = position;
        }
      }
    }
    if (event.type !== "session_sync" || event.phase !== "complete") return null;
    const start = this.boundary;
    const items = this.items ? [...this.items.values()] : [];
    const invalid = this.invalid;
    const liveTailIds = this.liveTailIds;
    this.items = null;
    this.boundary = null;
    this.invalid = false;
    this.lastStagedPosition = undefined;
    this.liveTailIds = new Set();
    if (!start || invalid || !matchingBoundary(start, event)) return null;
    if (!event.reset) {
      this.checkpointAccepted = true;
      return null;
    }
    if (items.length !== (event.windowItemCount ?? event.itemCount)) return null;
    const range =
      event.windowStartPosition !== undefined
        ? { start: event.windowStartPosition, end: event.lastPosition }
        : { start: 0, end: event.lastPosition };
    if (event.windowStartPosition !== undefined) {
      const positions = new Set<number>();
      for (const item of items) {
        const position = itemPosition(item.position);
        if (
          position === undefined ||
          position < range.start ||
          position > range.end ||
          positions.has(position)
        )
          return null;
        positions.add(position);
      }
      const first = items.reduce<ConversationItem | undefined>(
        (oldest, item) => (!oldest || item.position! < oldest.position! ? item : oldest),
        undefined,
      );
      if ((first?.id ?? null) !== event.firstItemId) return null;
    }
    this.checkpointAccepted = true;
    const replacementBase =
      event.windowStartPosition !== undefined
        ? current
        : current.filter(
            (block) =>
              !isCommittedBlock(block) ||
              block.ctx.position! <= event.lastPosition ||
              (block.ctx.itemId != null && liveTailIds.has(block.ctx.itemId)),
          );
    return replaceCanonicalTranscript(replacementBase, items, range);
  }
}

const boundaryKeys = [
  "reset",
  "lastPosition",
  "itemCount",
  "lastItemId",
  "streamEpoch",
  "itemRevision",
  "resetRevision",
  "windowStartPosition",
  "windowItemCount",
  "hasOlderItems",
  "firstItemId",
] as const satisfies readonly (keyof SessionSyncEvent)[];

function matchingBoundary(start: SessionSyncEvent, complete: SessionSyncEvent): boolean {
  return boundaryKeys.every((key) => start[key] === complete[key]);
}

function validResetBoundary(event: SessionSyncEvent): boolean {
  const count = event.windowItemCount ?? event.itemCount;
  return (
    Number.isSafeInteger(count) &&
    count >= 0 &&
    Number.isSafeInteger(event.lastPosition) &&
    event.lastPosition >= -1 &&
    (event.windowStartPosition === undefined ||
      (Number.isSafeInteger(event.windowStartPosition) &&
        event.windowStartPosition >= 0 &&
        (event.windowStartPosition <= event.lastPosition || count === 0))) &&
    (event.windowItemCount === undefined || event.windowStartPosition !== undefined) &&
    (event.windowStartPosition === undefined || event.firstItemId !== undefined)
  );
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
