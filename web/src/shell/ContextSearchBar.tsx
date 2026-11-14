// Modified for Triune.
import { useRef } from "react";
import { usePanelEscapeClose } from "@/hooks/usePanelEscapeClose";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip";
import { useContextSearch } from "./ContextSearchContext";
import { isIOSShell, isAndroidShell } from "@/lib/nativeBridge";

export function ContextSearchBar({ contained = false }: { contained?: boolean }) {
  const search = useContextSearch();
  const root = useRef<HTMLDivElement>(null);
  usePanelEscapeClose(!!search?.open && !!search.activeSessionId, search?.close, {
    scope: root,
    capture: true,
  });
  if (!search?.open || !search.activeSessionId) return null;
  const count = search.currentOccurrences.length;
  const incomplete =
    search.activeMessages.hasNextPage ||
    search.currentOccurrences.some(({ hit }) => hit.text_truncated);
  const counter = !search.query.trim()
    ? "Type to search"
    : !search.queryReady || search.activeMessages.isPending
      ? "Searching…"
      : count
        ? search.currentIndex < 0
          ? `${count}${incomplete ? "+" : ""} matches`
          : `${search.currentIndex + 1} of ${count}${incomplete ? "+" : ""}`
        : search.activeMessages.isError
          ? ""
          : "No matches";
  return (
    <div
      ref={root}
      data-context-search-region="chat"
      role="search"
      aria-label="Find in active chat"
      data-testid="context-search-bar"
      className={`${contained ? "relative shrink-0" : "absolute inset-x-0 top-14 md:top-12 md:right-[var(--workspace-panel-offset,0px)]"} z-20 flex h-10 min-w-0 items-center gap-1 border-b bg-background px-3 text-xs`}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          search.close();
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          search.move(event.shiftKey ? -1 : 1);
        }
      }}
      tabIndex={0}
      style={
        !contained && (isIOSShell() || isAndroidShell())
          ? { transform: "translateY(max(0px, calc(var(--omnigent-safe-top, 0px) - 0.5rem)))" }
          : undefined
      }
    >
      <TooltipButton
        type="button"
        aria-label="Edit search query"
        tooltip="Edit query in sidebar"
        onClick={() => search.openSearch()}
        className="flex min-w-0 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent"
      >
        <SearchIcon className="size-3.5 shrink-0" />
        <span className="truncate">{search.query || "Search chats…"}</span>
      </TooltipButton>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="ml-auto shrink-0 px-1 tabular-nums text-muted-foreground"
      >
        {counter}
      </span>
      <TooltipButton
        type="button"
        aria-label="Previous match"
        tooltipShortcut={["Shift", "Enter"]}
        disabled={
          (!count && !search.activeMessages.hasNextPage) ||
          !search.queryReady ||
          search.activeMessages.isFetchingNextPage
        }
        onClick={() => search.move(-1)}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded hover:bg-accent disabled:opacity-40"
      >
        <ChevronUpIcon className="size-4" />
      </TooltipButton>
      <TooltipButton
        type="button"
        aria-label="Next match"
        tooltipShortcut={["Enter"]}
        disabled={
          (!count && !search.activeMessages.hasNextPage) ||
          !search.queryReady ||
          search.activeMessages.isFetchingNextPage
        }
        onClick={() => search.move(1)}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded hover:bg-accent disabled:opacity-40"
      >
        <ChevronDownIcon className="size-4" />
      </TooltipButton>
      <span aria-hidden className="mx-1 h-4 border-l" />
      <TooltipButton
        type="button"
        aria-label="Close search"
        tooltipShortcut={["Esc"]}
        onClick={search.close}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded hover:bg-accent"
      >
        <XIcon className="size-4" />
      </TooltipButton>
    </div>
  );
}
