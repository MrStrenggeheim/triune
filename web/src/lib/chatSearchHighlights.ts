// Modified for Triune; inherited notices remain applicable.
import type { Bubble } from "@/lib/renderItems";
import { findMessageElement } from "@/lib/messageDeepLink";
import { createContext } from "react";
import { messageSearchSource } from "@/lib/messageSearchSource";

export interface SearchSource {
  itemId: string;
  rowId: string;
  text: string;
}

/** Transcript-owned reveal state outlives individual virtual rows. */
export interface ChatSearchRevealState {
  revealedItems: ReadonlySet<string>;
  originalSources: ReadonlyMap<string, string>;
  revealRequest?: { itemId: string; revision: number };
  reveal: (itemId: string) => void;
  showOriginal: (itemId: string, text: string) => void;
}

export const ChatSearchRevealContext = createContext<ChatSearchRevealState | null>(null);

// ChatMarkdown bypasses Markdown for huge text and long unbroken tokens.
export const CHAT_SEARCH_BODY_SELECTOR = ".message-markdown, [data-chat-plain-text]";

/** Stored assistant item IDs belong to text sections inside a response row. */
export function chatSearchSources(bubbles: readonly Bubble[]): SearchSource[] {
  return bubbles.flatMap((bubble): SearchSource[] => {
    if (bubble.kind === "user") {
      return [
        {
          itemId: bubble.itemId,
          rowId: bubble.itemId,
          text: messageSearchSource(bubble.content),
        },
      ];
    }
    if (bubble.kind !== "assistant") return [];
    const sections = bubble.items.filter((item) => item.kind === "text");
    return sections.flatMap((item) =>
      item.itemId
        ? [
            {
              itemId: item.itemId,
              rowId: bubble.responseId,
              text:
                "searchText" in item && typeof item.searchText === "string"
                  ? item.searchText
                  : item.text,
            },
          ]
        : [],
    );
  });
}

export function searchSourceElement(root: Element, source: SearchSource): Element | null {
  const row = findMessageElement(source.rowId, root);
  if (!row) return null;
  const section = Array.from(row.querySelectorAll<HTMLElement>("[data-search-item-id]")).find(
    (element) => element.dataset.searchItemId === source.itemId,
  );
  // A user row itself carries the stored item identity.
  const owner = section ?? (source.rowId === source.itemId ? row : null);
  return owner?.querySelector(CHAT_SEARCH_BODY_SELECTOR) ?? null;
}

interface TextPoint {
  node: Text;
  offset: number;
}
const EXCLUDED =
  'button,script,style,svg,math,[hidden],[aria-hidden="true"],[data-streamdown="code-block-header"]';

function renderedCharacters(root: Element) {
  const points: (TextPoint | null)[] = [];
  let text = "";
  let previousBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(EXCLUDED)) continue;
    const block =
      node.parentElement?.closest("p,pre,li,td,th,h1,h2,h3,h4,h5,h6,blockquote") ?? root;
    if (previousBlock && previousBlock !== block) {
      text += "\n";
      points.push(null);
    }
    previousBlock = block;
    const value = node.nodeValue ?? "";
    for (let offset = 0; offset < value.length; offset++) {
      points.push({ node: node as Text, offset });
    }
    text += value;
  }
  return { text, points };
}

/**
 * Align the entire rendered text in both directions, rejecting ambiguous source
 * positions instead of selecting a repeated snippet by its ordinal.
 * Whitespace is verified again against the final DOM Range.
 */
export function sourceOccurrenceRange(
  root: Element,
  source: string,
  start: number,
  end: number,
): Range | null {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > source.length
  )
    return null;
  const { text, points } = renderedCharacters(root);
  const visible = Array.from({ length: text.length }, (_, i) => i).filter(
    (i) => !/\s/u.test(text[i]),
  );
  const earliest: number[] = [],
    latest: number[] = [];
  let cursor = 0;
  for (const index of visible) {
    const found = source.indexOf(text[index], cursor);
    if (found < 0) return null;
    earliest.push(found);
    cursor = found + 1;
  }
  cursor = source.length - 1;
  for (let i = visible.length - 1; i >= 0; i--) {
    const found = source.lastIndexOf(text[visible[i]], cursor);
    if (found < 0) return null;
    latest[i] = found;
    cursor = found - 1;
  }
  const mapped = new Map<number, number>();
  for (let i = 0; i < visible.length; i++) {
    if (earliest[i] === latest[i]) mapped.set(earliest[i], visible[i]);
  }
  for (let offset = start; offset < end; offset++) {
    if (!/\s/u.test(source[offset]) && !mapped.has(offset)) return null;
  }
  const first = mapped.get(start),
    last = mapped.get(end - 1);
  if (first === undefined || last === undefined) return null;
  const range = document.createRange();
  range.setStart(points[first]!.node, points[first]!.offset);
  range.setEnd(points[last]!.node, points[last]!.offset + 1);
  return range.toString() === source.slice(start, end) ? range : null;
}

/** Literal Unicode search; only text inside message bodies participates. */
export function chatQueryRanges(root: Element, query: string): Range[] {
  if (!query) return [];
  const { text, points } = renderedCharacters(root);
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return Array.from(text.matchAll(expression)).flatMap((match) => {
    const first = points[match.index!],
      last = points[match.index! + match[0].length - 1];
    if (
      !first ||
      !last ||
      points.slice(match.index!, match.index! + match[0].length).includes(null)
    )
      return [];
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    return [range];
  });
}

export const CHAT_SEARCH_HIGHLIGHT = "chat-search";
export const CHAT_SEARCH_ACTIVE_HIGHLIGHT = "chat-search-active";

export function paintChatSearchHighlights(ranges: Range[], active: Range | null): void {
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
  CSS.highlights.set(CHAT_SEARCH_HIGHLIGHT, new Highlight(...ranges));
  const selected = new Highlight(...(active ? [active] : []));
  selected.priority = 1;
  CSS.highlights.set(CHAT_SEARCH_ACTIVE_HIGHLIGHT, selected);
}

export function clearChatSearchHighlights(): void {
  if (typeof CSS === "undefined" || !CSS.highlights) return;
  CSS.highlights.delete(CHAT_SEARCH_HIGHLIGHT);
  CSS.highlights.delete(CHAT_SEARCH_ACTIVE_HIGHLIGHT);
}
