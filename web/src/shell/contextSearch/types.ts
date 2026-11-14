// Modified for Triune.
export type ContextSearchScope = "current" | "all";
export type MessageSearchFilter = "all" | "final" | "user";

export interface SearchRange {
  start: number;
  end: number;
}

export interface MessageSearchHit {
  kind?: "message" | "chat";
  sender_name?: string | null;
  user_authored?: boolean | null;
  phase?: string | null;
  title_ranges?: SearchRange[] | null;
  session_id: string;
  title: string | null;
  item_id: string;
  role: string;
  created_at: number | null;
  text: string;
  text_start?: number;
  text_truncated?: boolean;
  content_hash: string;
  snippet: string;
  snippet_start: number;
  ranges: SearchRange[];
  occurrence_count: number;
}

export interface MessageSearchPage {
  data: MessageSearchHit[];
  has_more: boolean;
  next_cursor: string | null;
  total?: number;
}

export interface ContextSearchTarget {
  conversationId: string;
  itemId: string;
  range: SearchRange;
  sourceText: string;
  content_hash: string;
  textStart?: number;
  requestId?: number;
}

export interface SearchOccurrence {
  hit: MessageSearchHit;
  range: SearchRange;
}

export function occurrenceKey(occurrence: SearchOccurrence): string {
  return `${occurrence.hit.session_id}:${occurrence.hit.item_id}:${occurrence.range.start}`;
}

export function targetKey(target: ContextSearchTarget | null): string {
  return target ? `${target.conversationId}:${target.itemId}:${target.range.start}` : "";
}

export function searchOccurrences(hits: readonly MessageSearchHit[]): SearchOccurrence[] {
  return searchResults(hits).flatMap((hit) =>
    hit.kind === "chat" ? [] : hit.ranges.map((range) => ({ hit, range })),
  );
}

export function searchHitKey(hit: MessageSearchHit): string {
  return `${hit.kind ?? "message"}:${hit.session_id}:${hit.kind === "chat" ? "" : hit.item_id}`;
}

/** Preserve the server's date order and cursor tie-breakers across overlapping pages. */
export function searchResults(hits: readonly MessageSearchHit[]): MessageSearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = searchHitKey(hit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function occurrenceTarget(
  occurrence: SearchOccurrence,
  requestId: number,
): ContextSearchTarget {
  return {
    conversationId: occurrence.hit.session_id,
    itemId: occurrence.hit.item_id,
    range: occurrence.range,
    sourceText: occurrence.hit.text,
    content_hash: occurrence.hit.content_hash,
    textStart: occurrence.hit.text_start,
    requestId,
  };
}
