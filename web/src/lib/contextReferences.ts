// Modified for Triune.

import { authenticatedFetch } from "./identity";
import { withBasePath } from "./basePath";

export { QUOTE_SUBCHAT_HISTORY_LABEL, shouldHideQuoteSubchatHistory } from "./inheritedHistory";

export type ReferenceScope = "whole" | "last_answer" | "messages" | "quote";
export const referenceScopeLabels: Record<ReferenceScope, string> = {
  whole: "Whole chat",
  last_answer: "Last completed answer",
  messages: "Selected messages",
  quote: "Selected text",
};
export interface ReferenceItem {
  id: string;
  response_id: string;
  created_at: number;
  role?: string;
  created_by?: string;
  model?: string;
  content?: { type: string; text?: string }[];
  [key: string]: unknown;
}
export interface ContextReference {
  version: 1;
  snapshot_id: string;
  source_id: string;
  source_title: string;
  destination_id: string | null;
  scope: ReferenceScope;
  boundary_id: string;
  captured_at: number;
  items: ReferenceItem[];
  quote: string | null;
  audience: string;
  representation: string;
  /** Draft-only provenance: this fork already contains the captured source history. */
  inherited_by?: string;
}
export interface ReferenceChat {
  message_id?: string;
  snippet?: string;
  id: string;
  title: string;
  parent_id: string | null;
}
export interface QuoteSource {
  conversationId: string;
  boundaryId: string;
  text: string;
  messageIds?: string[];
  file?: {
    path: string;
    workspaceRoot: string | null;
    workspaceId?: string;
    hostId?: string | null;
  };
}

export async function referenceRequest<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await authenticatedFetch(
    url,
    body === undefined
      ? { signal }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : `Context request failed (${response.status})`,
    );
  }
  return response.json();
}
export function searchReferenceChats(
  query: string,
  writable = false,
  signal?: AbortSignal,
  after?: string,
  messages = false,
) {
  const params = new URLSearchParams({
    query,
    writable: String(writable),
    messages: String(messages),
  });
  if (after) params.set("after", after);
  return referenceRequest<{ data: ReferenceChat[]; has_more: boolean; next_cursor: string | null }>(
    `/v1/context-references/chats?${params}`,
    undefined,
    signal,
  );
}
export function captureReference(
  sourceId: string,
  destinationId: string | null,
  scope: ReferenceScope,
  options: { boundary_id?: string; message_ids?: string[]; quote?: string } = {},
) {
  return referenceRequest<ContextReference>(
    `/v1/sessions/${encodeURIComponent(sourceId)}/context-reference`,
    {
      destination_id: destinationId,
      scope,
      ...options,
    },
  );
}
export function serializeContextReference(reference: ContextReference): string {
  if (reference.inherited_by) return "";
  return `[Chat context snapshot]\n${JSON.stringify(reference)}\n[/Chat context snapshot]`;
}
export function referenceSourceUrl(sourceId: string, boundaryId: string): string {
  return withBasePath(
    `/c/${encodeURIComponent(sourceId)}?message=${encodeURIComponent(boundaryId)}`,
  );
}
