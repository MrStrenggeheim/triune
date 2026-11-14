// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import type { ReactNode } from "react";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import type {
  ContextSearchScope,
  MessageSearchFilter,
  MessageSearchHit,
  SearchRange,
} from "./contextSearch/types";

/** Search excerpts are text only: never load linked images, attachments or HTML. */
export function readableSearchSnippet(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[^\n]*\n?|```|~~~[^\n]*\n?|~~~/g, "")
    .replace(/(^|\n)\s*(?:#{1,6}\s+|>\s?)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .trim();
}

export function SearchExcerpt({
  text,
  query,
  ranges,
}: {
  text: string;
  query: string;
  ranges?: SearchRange[] | null;
}): ReactNode {
  if (ranges) {
    const parts: ReactNode[] = [];
    let cursor = 0;
    for (const { start, end } of ranges) {
      if (start < cursor || end <= start || start < 0 || end > text.length) continue;
      parts.push(
        text.slice(cursor, start),
        <mark key={start} className="bg-transparent font-semibold text-primary">
          {text.slice(start, end)}
        </mark>,
      );
      cursor = end;
    }
    parts.push(text.slice(cursor));
    return parts;
  }
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  let offset = 0;
  return parts.map((part) => {
    const start = offset;
    offset += part.length;
    return part.toLowerCase() === query.toLowerCase() ? (
      <mark key={start} className="bg-transparent font-semibold text-primary">
        {part}
      </mark>
    ) : (
      part
    );
  });
}

/** Protect source ranges before abbreviating Markdown so literal punctuation stays visible. */
export function MessageSearchExcerpt({ hit }: { hit: MessageSearchHit }): ReactNode {
  let prefix = "\uE000";
  while (hit.snippet.includes(prefix)) prefix += "\uE000";
  const matches: string[] = [];
  let cursor = 0;
  let protectedText = "";
  for (const range of hit.ranges) {
    const start = Math.max(range.start - hit.snippet_start, 0);
    const end = Math.min(range.end - hit.snippet_start, hit.snippet.length);
    if (end <= start || start < cursor) continue;
    protectedText += hit.snippet.slice(cursor, start) + `${prefix}${matches.length}\uE001`;
    matches.push(hit.snippet.slice(start, end));
    cursor = end;
  }
  protectedText += hit.snippet.slice(cursor);
  const parts = readableSearchSnippet(protectedText).split(
    new RegExp(`${prefix}(\\d+)\uE001`, "g"),
  );
  return parts.map((part, index) =>
    index % 2 ? (
      <mark key={part} className="bg-transparent font-semibold text-primary">
        {matches[Number(part)]}
      </mark>
    ) : (
      part
    ),
  );
}

export function SharedSearchResultRow({
  hit,
  query,
  scope = "all",
}: {
  hit: MessageSearchHit;
  query: string;
  scope?: ContextSearchScope;
}) {
  const title = hit.title ?? "Untitled chat";
  const sender =
    hit.sender_name ??
    (hit.user_authored === true
      ? "User"
      : hit.role === "assistant"
        ? "Assistant"
        : hit.role === "user"
          ? "External input"
          : hit.role || "Chat");
  const date = hit.created_at == null ? null : new Date(hit.created_at * 1000);
  return (
    <span
      className="block min-w-0 flex-1 text-left text-ui"
      data-search-result={hit.kind ?? "message"}
    >
      <span className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">
          {scope !== "current" && (
            <>
              <span>
                {hit.kind === "chat" ? (
                  <SearchExcerpt text={title} query={query} ranges={hit.title_ranges} />
                ) : (
                  title
                )}
              </span>
              :{" "}
            </>
          )}
          <span>{sender}</span>
        </span>
        {date && Number.isFinite(date.getTime()) && (
          <time
            dateTime={date.toISOString()}
            className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
          >
            {date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
          </time>
        )}
      </span>
      <span className="mt-0.5 block truncate text-muted-foreground">
        <MessageSearchExcerpt hit={hit} />
      </span>
    </span>
  );
}

const filters = [
  { value: "all", label: "All", tooltip: "Entire chat history" },
  {
    value: "final",
    label: "Final",
    tooltip: "User messages and final agent replies; no intermediate updates",
  },
  { value: "user", label: "User", tooltip: "User messages only" },
] as const;

export function MessageSearchFilterControl({
  value,
  onChange,
}: {
  value: MessageSearchFilter;
  onChange: (value: MessageSearchFilter) => void;
}) {
  return (
    <SegmentedControl aria-label="Message filter" className="h-auto min-h-6 max-w-full flex-wrap">
      {filters.map((filter) => (
        <SegmentedControlItem
          key={filter.value}
          label={filter.tooltip}
          aria-label={filter.label}
          active={value === filter.value}
          onClick={() => onChange(filter.value)}
        >
          {filter.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
