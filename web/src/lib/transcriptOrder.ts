// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import {
  LIVE_ITEM_PREFIX,
  type AnyBlock,
  type MessageContentBlock,
  type UserMessageBlock,
  type TextDone,
} from "./blocks";
import type { MessageCommunication } from "./messageCommunication";

/** Local placement uses identity and sequence, never a wall clock. */
export interface TranscriptAnchor {
  afterItemId: string | null;
  afterPosition: number;
  sequence: number;
}

export function itemPosition(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function isCommittedBlock(block: AnyBlock): boolean {
  return (
    !!block.ctx.itemId &&
    !block.ctx.itemId.startsWith(LIVE_ITEM_PREFIX) &&
    itemPosition(block.ctx.position) !== undefined
  );
}

interface BlockIndex {
  readonly items: ReadonlyMap<string, number>;
  readonly tools: ReadonlyMap<string, number>;
}
const indexes = new WeakMap<AnyBlock[], BlockIndex>();
const projectionStructureStamps = new WeakMap<AnyBlock[], object>();

/** Only validated native-preview content replacements share discovery inputs. */
export function projectionStructureStamp(blocks: AnyBlock[]): object {
  let stamp = projectionStructureStamps.get(blocks);
  if (!stamp) {
    stamp = Object.freeze({});
    projectionStructureStamps.set(blocks, stamp);
  }
  return stamp;
}

/** Scoped to one immutable conversation array; no cross-viewer identity cache. */
export function transcriptIndex(blocks: AnyBlock[]): BlockIndex {
  let index = indexes.get(blocks);
  if (index) return index;
  const items = new Map<string, number>();
  const tools = new Map<string, number>();
  index = { items, tools };
  blocks.forEach((block, at) => {
    if (block.ctx.itemId && !items.has(block.ctx.itemId)) items.set(block.ctx.itemId, at);
    if (block.type === "tool_group")
      for (const execution of block.executions) tools.set(execution.callId, at);
  });
  indexes.set(blocks, index);
  return index;
}

export interface NativePreviewContentUpdate {
  base: AnyBlock[];
  changes: ReadonlyMap<
    number,
    Pick<TextDone, "fullText" | "hasCodeBlocks" | "streamIndex" | "previewInterrupted">
  >;
}

/** Replace placed preview content without changing membership, placement or index identity. */
export function replaceNativePreviewContent(
  current: AnyBlock[],
  update: NativePreviewContentUpdate,
): AnyBlock[] | null {
  if (current !== update.base || update.changes.size === 0) return null;
  for (const at of update.changes.keys()) {
    const block = current[at];
    if (
      !block ||
      block.type !== "text_done" ||
      !block.ctx.itemId?.startsWith(LIVE_ITEM_PREFIX) ||
      !block.ctx.anchor ||
      block.ctx.position !== undefined
    )
      return null;
  }
  const next = current.slice();
  for (const [at, content] of update.changes) {
    const block = current[at]! as TextDone;
    next[at] = {
      ...block,
      fullText: content.fullText,
      hasCodeBlocks: content.hasCodeBlocks,
      ...(content.streamIndex !== undefined ? { streamIndex: content.streamIndex } : {}),
      ...(content.previewInterrupted !== undefined
        ? { previewInterrupted: content.previewInterrupted }
        : {}),
    };
  }
  indexes.set(next, transcriptIndex(current));
  projectionStructureStamps.set(next, projectionStructureStamp(current));
  return next;
}

interface PendingPlacement {
  tempId: string;
  itemId?: string;
  anchor?: TranscriptAnchor;
}

/** Pending inputs must form bubble boundaries before the renderer groups assistant work. */
export function projectPendingTranscript(
  blocks: AnyBlock[],
  pending: readonly (PendingPlacement & {
    content: MessageContentBlock[];
    position?: number;
    author?: string;
    createdAtS?: number;
    communication?: MessageCommunication;
    sentMidTurn?: boolean;
  })[],
  selfAuthor: string | null,
): AnyBlock[] {
  const committed = transcriptIndex(blocks).items;
  const projected = pending.flatMap((input): UserMessageBlock[] => {
    if (!input.anchor && input.position === undefined) return [];
    const itemId = input.itemId ?? input.tempId;
    if (committed.has(itemId)) return [];
    const author = input.author ?? selfAuthor;
    return [
      {
        type: "user_message",
        pending: true,
        awaitingAgent: input.sentMidTurn,
        userAuthored: !input.communication,
        content: input.content,
        stableKey: input.tempId,
        ...(input.communication ? { communication: input.communication } : {}),
        ctx: {
          agent: null,
          depth: 0,
          turn: 0,
          timestamp: 0,
          responseId: "",
          itemId,
          ...(input.position !== undefined ? { position: input.position } : {}),
          ...(input.anchor ? { anchor: input.anchor } : {}),
          ...(author ? { createdBy: author } : {}),
          ...(input.createdAtS !== undefined ? { clientCreatedAtS: input.createdAtS } : {}),
        },
      },
    ];
  });
  return projected.length ? orderTranscriptBlocks([...blocks, ...projected]) : blocks;
}

interface TranscriptState<P extends PendingPlacement> {
  blocks: AnyBlock[];
  pendingUserMessages: P[];
}

function blockKey(block: AnyBlock): string {
  return block.ctx.itemId ?? `overlay:${block.ctx.anchor?.sequence ?? "unplaced"}`;
}

/** Canonical positions order saved items; anchored local records retain their insertion boundary. */
export function orderTranscriptBlocks(blocks: AnyBlock[]): AnyBlock[] {
  const committed: AnyBlock[] = [];
  const overlays: AnyBlock[] = [];
  for (const block of blocks) (isCommittedBlock(block) ? committed : overlays).push(block);
  // An unpositioned live/legacy record cannot disable canonical ordering of saved rows.
  committed.sort((a, b) => a.ctx.position! - b.ctx.position!);
  const children = new Map<string | null, AnyBlock[]>();
  const keys = new Set(blocks.map(blockKey));
  for (const block of overlays) {
    const anchor = block.ctx.anchor;
    let parent = anchor?.afterItemId ?? null;
    if (parent !== null && !keys.has(parent)) {
      parent =
        committed.findLast(
          (candidate) =>
            candidate.ctx.position !== undefined &&
            candidate.ctx.position <= (anchor?.afterPosition ?? -1),
        )?.ctx.itemId ?? null;
    }
    // Missing legacy metadata stays at the tail until the store stamps its boundary.
    if (!anchor) parent = committed.at(-1)?.ctx.itemId ?? null;
    const group = children.get(parent) ?? [];
    group.push(block);
    children.set(parent, group);
  }
  for (const group of children.values())
    group.sort((a, b) => (a.ctx.anchor?.sequence ?? 0) - (b.ctx.anchor?.sequence ?? 0));
  const ordered: AnyBlock[] = [];
  const emitted = new Set<AnyBlock>();
  const emitChildren = (key: string | null) => {
    for (const child of children.get(key) ?? []) {
      if (emitted.has(child)) continue;
      emitted.add(child);
      ordered.push(child);
      emitChildren(blockKey(child));
    }
  };
  emitChildren(null);
  committed.forEach((block, index) => {
    ordered.push(block);
    // One saved item can produce several blocks (e.g. a receipt plus its card).
    if (committed[index + 1]?.ctx.itemId !== block.ctx.itemId) emitChildren(blockKey(block));
  });
  // A pending input can own an overlay boundary without belonging to the block lane.
  for (const block of overlays) {
    if (emitted.has(block)) continue;
    emitted.add(block);
    ordered.push(block);
    emitChildren(blockKey(block));
  }
  return ordered.every((block, at) => block === blocks[at]) ? blocks : ordered;
}

/** Stamp once at the store mutation boundary, including pending inputs before early output. */
export function normalizeTranscript<P extends PendingPlacement>(
  before: TranscriptState<P>,
  after: TranscriptState<P>,
): TranscriptState<P> {
  let sequence = 0;
  let lastId: string | null = null;
  let lastPosition = -1;
  const anchors = new Map<string, TranscriptAnchor>();
  for (const block of before.blocks) {
    if (block.ctx.anchor) {
      sequence = Math.max(sequence, block.ctx.anchor.sequence);
      if (block.ctx.itemId) anchors.set(block.ctx.itemId, block.ctx.anchor);
    }
    if (block.ctx.position !== undefined) lastPosition = Math.max(lastPosition, block.ctx.position);
    lastId = block.ctx.itemId ?? (block.ctx.anchor ? blockKey(block) : lastId);
  }
  for (const pending of before.pendingUserMessages) {
    if (pending.anchor) {
      sequence = Math.max(sequence, pending.anchor.sequence);
      anchors.set(pending.tempId, pending.anchor);
    }
  }
  const anchor = (): TranscriptAnchor => ({
    afterItemId: lastId,
    afterPosition: lastPosition,
    sequence: ++sequence,
  });
  if (lastId === null) {
    const tail = after.blocks.findLast(isCommittedBlock);
    lastId = tail?.ctx.itemId ?? null;
    lastPosition = tail?.ctx.position ?? -1;
  }
  // Existing pending inputs precede output received while their consumed echo is delayed.
  const pendingUserMessages = after.pendingUserMessages.map((pending) => {
    const placement = pending.anchor ?? anchors.get(pending.tempId) ?? anchor();
    lastId = pending.itemId ?? pending.tempId;
    return pending.anchor === placement ? pending : { ...pending, anchor: placement };
  });
  const oldBlocks = new Set(before.blocks);
  const promoted = new Map(
    after.blocks.flatMap((block) =>
      block.type === "user_message" && block.stableKey && block.ctx.itemId
        ? [[block.stableKey, block.ctx.itemId] as const]
        : [],
    ),
  );
  for (const pending of after.pendingUserMessages)
    if (pending.itemId) promoted.set(pending.tempId, pending.itemId);
  const blocks = after.blocks.map((block) => {
    if (isCommittedBlock(block)) {
      // Promotion adopts the local input's boundary for stable pending/preview placement.
      return block;
    }
    let placement =
      block.ctx.anchor ?? (block.ctx.itemId ? anchors.get(block.ctx.itemId) : undefined);
    const appended = !placement && !oldBlocks.has(block);
    if (!placement) {
      if (oldBlocks.has(block)) {
        const at = before.blocks.indexOf(block);
        const preceding = before.blocks.slice(0, at).findLast(isCommittedBlock);
        placement = {
          afterItemId: preceding?.ctx.itemId ?? null,
          afterPosition: preceding?.ctx.position ?? -1,
          sequence: ++sequence,
        };
      } else placement = anchor();
    }
    if (placement.afterItemId && promoted.has(placement.afterItemId))
      placement = { ...placement, afterItemId: promoted.get(placement.afterItemId)! };
    const next =
      block.ctx.anchor === placement
        ? block
        : { ...block, ctx: { ...block.ctx, anchor: placement } };
    // Revisiting an earlier overlay must not move the insertion point above a later prompt.
    if (appended) lastId = blockKey(next);
    return next;
  });
  return {
    blocks: orderTranscriptBlocks(
      blocks.every((block, at) => block === after.blocks[at]) ? after.blocks : blocks,
    ),
    pendingUserMessages: pendingUserMessages.every(
      (pending, at) => pending === after.pendingUserMessages[at],
    )
      ? after.pendingUserMessages
      : pendingUserMessages,
  };
}

/** Learn authoritative positions even for items already present before reconnect. */
export function refreshItemPositions(current: AnyBlock[], snapshot: AnyBlock[]): AnyBlock[] {
  const contexts = new Map(
    snapshot.flatMap((block) => (block.ctx.itemId ? [[block.ctx.itemId, block.ctx] as const] : [])),
  );
  let changed = false;
  const blocks = current.map((block) => {
    const saved = block.ctx.itemId ? contexts.get(block.ctx.itemId) : undefined;
    if (!saved) return block;
    const position = saved.position ?? block.ctx.position;
    const aliases = saved.aliases ?? block.ctx.aliases;
    if (
      position === block.ctx.position &&
      (aliases === block.ctx.aliases ||
        (aliases?.length === block.ctx.aliases?.length &&
          aliases?.every((alias, at) => alias === block.ctx.aliases?.[at])))
    )
      return block;
    changed = true;
    return {
      ...block,
      ctx: {
        ...block.ctx,
        ...(position !== undefined ? { position } : {}),
        ...(aliases ? { aliases } : {}),
      },
    };
  });
  return orderTranscriptBlocks(changed ? blocks : current);
}
