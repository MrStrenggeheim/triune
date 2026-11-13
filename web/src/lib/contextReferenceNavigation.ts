// Modified for Triune.
import { createDurableSubchat } from "@/workbench/durableSubchat";
import { createContext } from "react";
import type { QuoteSource } from "./contextReferences";
import { QUOTE_SUBCHAT_HISTORY_LABEL } from "./inheritedHistory";
import { updateSession } from "./sessionsApi";

export interface ContextReferenceNavigation {
  openConversation: (
    id: string,
    options?: { beside?: boolean; messageId?: string; title?: string },
  ) => void;
  /** Await draft insertion/opening after creation, before runner initialization. */
  createSubchat?: (
    source: QuoteSource,
    onCreated?: (id: string) => void | Promise<void>,
  ) => Promise<string>;
}
export const ContextReferenceNavigationContext = createContext<ContextReferenceNavigation | null>(
  null,
);

/** Create a durable branch at a captured item without waking or sending to either agent. */
export async function createQuoteSubchat(
  source: QuoteSource,
  onCreated?: (id: string) => void | Promise<void>,
): Promise<string> {
  if (!source.boundaryId || source.file)
    throw new Error("A captured conversation item is required");
  return createDurableSubchat(
    source.conversationId,
    source.boundaryId,
    JSON.stringify([
      "quote",
      source.conversationId,
      source.boundaryId,
      source.messageIds,
      source.text,
    ]),
    async (id) => {
      await updateSession(id, { labels: { [QUOTE_SUBCHAT_HISTORY_LABEL]: source.boundaryId } });
      await onCreated?.(id);
    },
  );
}
