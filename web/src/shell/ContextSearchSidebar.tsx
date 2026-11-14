// Modified for Triune.
import { usePanelEscapeClose } from "@/hooks/usePanelEscapeClose";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, SearchIcon, XIcon } from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { useContextSearch } from "./ContextSearchContext";
import { searchHitKey, targetKey } from "./contextSearch/types";
import { SharedSearchResultRow, MessageSearchFilterControl } from "./SharedSearchResultRow";

const rowClass =
  "w-full min-w-0 rounded-md px-2 py-2 text-left text-ui outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent";

export function ContextSearchSidebar() {
  const search = useContextSearch();
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [keyboardSelection, setKeyboardSelection] = useState("");
  const open = search?.open ?? false;
  const focusRequest = search?.focusRequest;
  usePanelEscapeClose(open, search?.close, { scope: root, capture: true });
  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open, focusRequest]);
  useEffect(() => setKeyboardSelection(""), [search?.query, search?.scope, search?.messageFilter]);
  useEffect(() => {
    if (results.current) results.current.scrollTop = 0;
  }, [search?.settledQuery, search?.scope, search?.messageFilter]);
  useEffect(() => {
    if (search?.highlightTarget?.requestId !== undefined) setKeyboardSelection("");
  }, [search?.highlightTarget?.requestId]);
  const highlightKey = targetKey(search?.highlightTarget ?? null);
  useEffect(() => {
    if (!open) return;
    const selected = results.current?.querySelector<HTMLElement>('[data-search-selected="true"]');
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [open, highlightKey, keyboardSelection]);

  if (!search?.open) return null;
  const activations = new Map<string, () => void>();
  if (search.queryReady)
    for (const hit of search.hits) {
      const range = hit.ranges[0];
      if (hit.kind === "chat")
        activations.set(searchHitKey(hit), () => search.goToTitle(hit.session_id));
      else if (range) activations.set(searchHitKey(hit), () => search.activate({ hit, range }));
    }
  const keys = [...activations.keys()];
  const selectedKey =
    keyboardSelection ||
    (search.highlightTarget
      ? `message:${search.highlightTarget.conversationId}:${search.highlightTarget.itemId}`
      : (keys[0] ?? ""));
  const loading = !search.queryReady || search.messages.isFetching;

  return (
    <section
      ref={root}
      aria-label="Chat search"
      data-testid="context-search-sidebar"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          search.close();
        }
      }}
    >
      <div className="shrink-0 space-y-3 px-3 pt-2 pb-3">
        <div className="flex items-center justify-between text-ui font-medium">
          <span>Search</span>
          <TooltipButton
            type="button"
            aria-label="Close search"
            tooltipShortcut={["Esc"]}
            onClick={search.close}
            className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent"
          >
            <ArrowLeftIcon className="size-4 md:hidden" />
            <XIcon className="hidden size-4 md:block" />
          </TooltipButton>
        </div>
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
          />
          <Input
            ref={input}
            value={search.query}
            aria-label="Search chats"
            placeholder="Search chats…"
            className="pl-8 pr-8"
            onChange={(event) => search.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.defaultPrevented) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = keys.indexOf(selectedKey);
                const direction = event.key === "ArrowDown" ? 1 : -1;
                const next =
                  index < 0
                    ? direction === 1
                      ? 0
                      : keys.length - 1
                    : (index + direction + keys.length) % keys.length;
                setKeyboardSelection(keys[next] ?? "");
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (
                  search.scope === "current" &&
                  !keyboardSelection &&
                  search.currentOccurrences.length
                )
                  search.move(event.shiftKey ? -1 : 1);
                else activations.get(selectedKey || keys[0])?.();
              }
            }}
          />
          {search.query && (
            <TooltipButton
              type="button"
              aria-label="Clear search query"
              onClick={() => {
                search.setQuery("");
                input.current?.focus();
              }}
              className="absolute top-0 right-0 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </TooltipButton>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Search in</span>
          <SegmentedControl
            aria-label="Search scope"
            className="h-auto min-h-6 max-w-full flex-wrap"
          >
            {(
              [
                ["current", "Current chat"],
                ["all", "All chats"],
              ] as const
            ).map(([scope, label]) => (
              <SegmentedControlItem
                key={scope}
                label={label}
                active={search.scope === scope}
                disabled={scope === "current" && !search.activeSessionId}
                onClick={() => search.setScope(scope)}
              >
                {label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
        <MessageSearchFilterControl
          value={search.messageFilter}
          onChange={search.setMessageFilter}
        />
      </div>
      <div
        ref={results}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
        aria-label="Search results"
      >
        {!search.query.trim() && (
          <p className="px-2 py-2 text-xs text-muted-foreground">Find messages and chats.</p>
        )}
        {!!search.query.trim() && loading && (
          <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
            Searching…
          </p>
        )}
        {!!search.settledQuery &&
          search.hits.map((hit) => {
            const key = searchHitKey(hit);
            const selected = key === selectedKey;
            return (
              <TooltipButton
                key={key}
                type="button"
                data-search-selected={selected}
                aria-pressed={selected}
                disabled={!search.queryReady || !activations.has(key)}
                onClick={() => {
                  setKeyboardSelection(hit.kind === "chat" ? key : "");
                  activations.get(key)?.();
                }}
                className={cn(
                  rowClass,
                  "my-0.5 border border-transparent disabled:opacity-50",
                  selected && "border-primary/25 bg-accent",
                )}
                tooltip={hit.kind === "chat" ? "Open chat" : "Open matching message"}
              >
                <SharedSearchResultRow hit={hit} query={search.settledQuery} scope={search.scope} />
              </TooltipButton>
            );
          })}
        {search.messages.hasNextPage && !search.messages.isFetchNextPageError && (
          <TooltipButton
            type="button"
            className="w-full rounded px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent"
            disabled={search.messages.isFetching || !search.queryReady}
            onClick={() => {
              void search.messages.fetchNextPage();
            }}
          >
            {search.messages.isFetchingNextPage ? "Loading…" : "Show more results"}
          </TooltipButton>
        )}
        {!!search.query.trim() && !loading && !search.hits.length && !search.messages.isError && (
          <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
            No results found.
          </p>
        )}
      </div>
    </section>
  );
}
