// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { MessageContentBlock } from "./blocks";
import { authenticatedFetch } from "./identity";
import { apiErrorFromResponse } from "./sessionsApi";
import { mergePlacedPendingBubbles, type Bubble } from "./renderItems";
import type { PendingUserMessage } from "@/store/chatStore";

export interface StartupInputReceipt {
  item_id: string;
  position: number;
  created_at: number;
  cancelled_at: number;
  reason: "stop" | "interrupt";
  state: "cancelled_before_sending" | "delivery_unknown";
  content: MessageContentBlock[];
}

export const startupInputReceiptKey = (id: string) => ["startup-input-receipts", id] as const;

export async function fetchStartupInputReceipts(
  id: string,
  before: number | undefined,
  signal: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "100" });
  if (before !== undefined) params.set("before_position", String(before));
  const response = await authenticatedFetch(
    `/v1/sessions/${encodeURIComponent(id)}/startup-input-receipts?${params}`,
    { signal },
  );
  if (!response.ok) throw await apiErrorFromResponse(response);
  return (await response.json()) as { data: StartupInputReceipt[]; has_more: boolean };
}

/** Replace provisional bubbles only by server-issued item/submission identity. */
export function mergeStartupInputReceipts(
  bubbles: Bubble[],
  receipts: StartupInputReceipt[],
  pending: readonly PendingUserMessage[],
): Bubble[] {
  if (receipts.length === 0) return bubbles;
  const byId = new Map(receipts.map((receipt) => [receipt.item_id, receipt]));
  const pendingAliases = new Map<string, string>();
  for (const message of pending) {
    const id = [message.itemId, message.stableId, message.tempId].find(
      (candidate) => candidate && byId.has(candidate),
    );
    if (id) pendingAliases.set(message.tempId, id);
  }
  const visible = bubbles.filter((bubble) => {
    if (bubble.kind !== "user") return true;
    const ids = [
      bubble.itemId,
      ...(bubble.aliases ?? []),
      pendingAliases.get(bubble.stableKey ?? bubble.itemId),
    ];
    // Only the server's native input alias proves consumption. A saved item with
    // the same ID can still be an old, unacknowledged projection after Stop.
    if (!bubble.pending) {
      for (const alias of bubble.aliases ?? []) byId.delete(alias);
    }
    return !ids.some((id) => id && byId.has(id));
  });
  const retained: Bubble[] = Array.from(byId.values(), (receipt) => ({
    kind: "user",
    userAuthored: true,
    itemId: receipt.item_id,
    content: receipt.content,
    position: receipt.position,
    createdAtS: receipt.created_at,
    startupReceipt: receipt,
  }));
  return mergePlacedPendingBubbles(visible, retained);
}
