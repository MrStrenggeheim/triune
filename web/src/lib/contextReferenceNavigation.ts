// Modified for Triune.
import { createDurableSubchat } from "@/workbench/durableSubchat";
import { createContext } from "react";
import type { QuoteSource } from "./contextReferences";

export interface ContextReferenceNavigation {
  openConversation: (id: string, options?: { beside?: boolean; messageId?: string }) => void;
  /** Create a durable branch at source.boundaryId without sending its draft. */
  createSubchat?: (source: QuoteSource) => Promise<string>;
}
export const ContextReferenceNavigationContext = createContext<ContextReferenceNavigation | null>(
  null,
);

/** Create a durable branch at a captured item without waking or sending to either agent. */
export async function createQuoteSubchat(source: QuoteSource): Promise<string> {
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
  );
}
