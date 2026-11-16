// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { itemPosition } from "./transcriptOrder";
import { readMessageCommunication } from "./messageCommunication";
import type { ConversationItem, MessageItem } from "./conversationItems";

export interface PeerReceiptScope {
  server: string;
  viewer: string;
  conversationId: string;
}

/** The caller supplies authorized server records, including durable native-echo bindings. */
export interface PeerReceiptPlacement {
  scope: PeerReceiptScope;
  item: MessageItem;
  pendingId?: string;
  nativeEchoIds?: readonly string[];
}

function positioned(item: ConversationItem): boolean {
  return itemPosition(item.position) !== undefined;
}

/** Convert only a server-authored accepted peer; human pending input keeps its queue lane. */
export function pendingPeerReceiptPlacement(
  value: unknown,
  scope: PeerReceiptScope,
): PeerReceiptPlacement | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pending = value as Record<string, unknown>;
  const communication = readMessageCommunication(pending.communication);
  if (
    communication?.kind !== "peer" ||
    communication.destination_conversation_id !== scope.conversationId ||
    typeof pending.item_id !== "string" ||
    pending.item_id !== communication.message_id ||
    typeof pending.pending_id !== "string" ||
    !pending.pending_id ||
    !Array.isArray(pending.content) ||
    itemPosition(pending.position) === undefined ||
    typeof pending.created_at !== "number" ||
    !Number.isFinite(pending.created_at)
  )
    return undefined;
  return {
    scope,
    pendingId: pending.pending_id,
    item: {
      id: pending.item_id,
      position: pending.position as number,
      created_at: pending.created_at,
      type: "message",
      role: "user",
      response_id: "pending_input",
      status: "incomplete",
      communication,
      content: pending.content as MessageItem["content"],
    },
  };
}

/** Project accepted receipts before item translation, pending merging and Worked segmentation. */
export function projectPeerReceipts(
  items: readonly ConversationItem[],
  receipts: readonly PeerReceiptPlacement[],
  scope: PeerReceiptScope,
) {
  const canonical = new Map(items.map((item) => [item.id, item]));
  const aliases = new Map<string, string>();
  const pendingIds = new Set<string>();
  const unplacedReceiptIds: string[] = [];
  for (const receipt of receipts) {
    const item = receipt.item;
    const origin = item.communication;
    if (
      receipt.scope.server !== scope.server ||
      receipt.scope.viewer !== scope.viewer ||
      receipt.scope.conversationId !== scope.conversationId ||
      item.type !== "message" ||
      item.role !== "user" ||
      item.is_meta ||
      origin?.kind !== "peer" ||
      origin.destination_conversation_id !== scope.conversationId ||
      origin.message_id !== item.id ||
      !positioned(item) ||
      typeof item.created_at !== "number" ||
      !Number.isFinite(item.created_at)
    )
      continue;
    // Unpositioned legacy windows cannot establish where a newly received item belongs.
    if (!canonical.has(item.id) && items.some((existing) => !positioned(existing))) {
      unplacedReceiptIds.push(item.id);
      continue;
    }
    const existing = canonical.get(item.id);
    // An accepted replay cannot downgrade an already confirmed durable receipt.
    if (!(
      existing?.type === "message" &&
      readMessageCommunication(existing.communication)?.delivery_state === "confirmed"
    ))
      canonical.set(item.id, item);
    aliases.set(item.id, item.id);
    if (receipt.pendingId) {
      pendingIds.add(receipt.pendingId);
      aliases.set(receipt.pendingId, item.id);
    }
    for (const alias of receipt.nativeEchoIds ?? []) {
      if (!alias || alias === item.id || alias === origin.reply_to_message_id) continue;
      const echo = canonical.get(alias);
      if (
        echo &&
        (echo.type !== "message" ||
          echo.role !== "user" ||
          echo.user_authored ||
          echo.communication ||
          echo.is_meta)
      )
        continue;
      aliases.set(alias, item.id);
      canonical.delete(alias);
    }
  }
  const projected = [...canonical.values()];
  if (projected.every(positioned)) projected.sort((a, b) => a.position! - b.position!);
  return { items: projected, aliases, pendingIds, unplacedReceiptIds };
}
