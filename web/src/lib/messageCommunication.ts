// Modified for Triune.
export interface MessageCommunication {
  kind: "peer" | "native_agent";
  message_id: string;
  source_conversation_id?: string | null;
  source_agent_id?: string | null;
  source_agent_name?: string | null;
  source_title?: string | null;
  destination_conversation_id: string;
  sent_at?: number | null;
  reply_to_message_id?: string | null;
  task_id?: string | null;
  delivery_state: "pending" | "queued" | "confirmed" | "unknown" | "failed";
  receipt?: "accepted" | "transcript" | "inbox_drained" | "model_consumed" | null;
  hop_count?: number;
}

/** Only structured server provenance can change a message's displayed author. */
export function readMessageCommunication(value: unknown): MessageCommunication | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (
    (data.kind !== "peer" && data.kind !== "native_agent") ||
    typeof data.message_id !== "string" ||
    !data.message_id ||
    typeof data.destination_conversation_id !== "string" ||
    !data.destination_conversation_id ||
    !["pending", "queued", "confirmed", "unknown", "failed"].includes(String(data.delivery_state))
  )
    return undefined;
  for (const key of [
    "source_conversation_id",
    "source_agent_id",
    "source_agent_name",
    "source_title",
    "reply_to_message_id",
    "task_id",
  ])
    if (data[key] != null && typeof data[key] !== "string") return undefined;
  return data as unknown as MessageCommunication;
}
