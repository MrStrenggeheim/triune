// Modified for Triune.
import { TooltipButton } from "@/components/ui/tooltip";
import type React from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileIcon, SearchIcon, XIcon } from "lucide-react";
import { useWorkspaceFileSearch } from "@/hooks/useWorkspaceChangedFiles";
import { queryIdentity } from "@/lib/workbenchWorkspace";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { isElectronShell } from "@/lib/nativeBridge";
import {
  mergePaletteCommands,
  paletteWorkflowActions,
  type CommandPaletteFileTarget,
} from "@/workbench/paletteCommands";

import { searchActions, filterSearchActions, type ActionCommand } from "./contextSearch/actions";
import { useNavigate } from "@/lib/routing";
import {
  type ConversationsPage,
  useConversations,
  useSessionSearch,
} from "@/hooks/useConversations";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { cn } from "@/lib/utils";
import { isImeCompositionKeyEvent } from "@/lib/ime";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { conversationDisplayLabel } from "./sidebarNav";
import {
  useMessageSearch,
  useMessageSearchIdentity,
  useMessageSearchNotice,
} from "@/hooks/useMessageSearch";
import { useContextSearch } from "./ContextSearchContext";
import {
  SharedSearchResultRow,
  MessageSearchFilterControl,
  SearchExcerpt,
} from "./SharedSearchResultRow";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  occurrenceTarget,
  searchHitKey,
  searchResults,
  type MessageSearchFilter,
  type ContextSearchScope,
  type ContextSearchTarget,
  type MessageSearchHit,
} from "./contextSearch/types";

export type { CommandPaletteFileTarget } from "@/workbench/paletteCommands";

export interface CommandPaletteProps {
  /** Workbench search opens below its shared header trigger, without a backdrop. */
  anchorSelector?: string;
  /** Captured resource scope; never inferred from active chat or surrounding context. */
  fileTarget?: CommandPaletteFileTarget;
  /** File paths are relative to target.folder, matching Explorer quick search. */
  onOpenFile?: (path: string, target: CommandPaletteFileTarget) => void;
  onFileSearch?: (query: string, target: CommandPaletteFileTarget) => void;
  onOpenProjects?: () => void;
  /** Captured actions supplied by the currently focused workbench view. */
  actions?: ActionCommand[];
  onMessageSearch?: (
    sessionId: string,
    query: string,
    target?: ContextSearchTarget,
    messageFilter?: MessageSearchFilter,
  ) => void;
  sessionsOnly?: boolean;
  onNavigate?: (path: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Flip the left (Conversations) sidebar — owned by AppShell. */
  onToggleLeftSidebar: () => void;
  /** Flip the right (Workspace) sidebar — owned by AppShell. */
  onToggleRightSidebar: () => void;
}

/** Debounce matches the sidebar search (300ms) so keystrokes don't each fetch. */
const SEARCH_DEBOUNCE_MS = 300;

/** How many recent sessions to show before the user types, so the Actions
    group stays visible without scrolling. Typing lifts the cap. */
const IDLE_SESSION_LIMIT = 5;
const SESSION_SEARCH_PAGE_BATCH = 10;
const SESSION_SEARCH_RESULT_LIMIT = 50;
/** Rows per page of each search group; "Show more" loads the next page. */
const SEARCH_GROUP_PAGE_SIZE = 8;
/** Keys that move cmdk's selection; see `userMovedSelection`. */
const SELECTION_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

interface PaletteSession {
  id: string;
  label: string;
  snippet: string | null;
}

/** Flatten list pages into palette rows, dropping archived and repeated ids. */
function paletteSessions(
  pages: readonly ConversationsPage[],
  excludeIds: ReadonlySet<string> = new Set(),
): PaletteSession[] {
  const seen = new Set(excludeIds);
  const out: PaletteSession[] = [];
  for (const page of pages) {
    for (const c of page.data) {
      if (c.archived || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({
        id: c.id,
        label: conversationDisplayLabel(c),
        // Present only when the match was in chat content (not the title);
        // the server omits it otherwise. Shown as a dimmed second line.
        snippet: c.search_snippet ?? null,
      });
    }
  }
  return out;
}

export function CommandPalette({
  anchorSelector,
  fileTarget,
  onOpenFile,
  onFileSearch,
  onOpenProjects,
  actions: suppliedActions,
  onMessageSearch,
  sessionsOnly = false,
  onNavigate,
  open,
  onOpenChange,
  onToggleLeftSidebar,
  onToggleRightSidebar,
}: CommandPaletteProps) {
  const navigateRoute = useNavigate();
  const navigate = onNavigate ?? navigateRoute;
  const isMobile = useIsMobileViewport();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const contextSearch = useContextSearch();
  const identity = useMessageSearchIdentity();
  const [localMessageFilter, setLocalMessageFilter] = useState<MessageSearchFilter>("all");
  const [localScope, setLocalScope] = useState<ContextSearchScope>("all");
  const messageFilter = contextSearch?.messageFilter ?? localMessageFilter;
  const setMessageFilter = contextSearch?.setMessageFilter ?? setLocalMessageFilter;
  const scope = contextSearch?.scope ?? localScope;
  const setScope = contextSearch?.setScope ?? setLocalScope;
  const sessionId = scope === "current" ? contextSearch?.activeSessionId : undefined;
  const [pageLimit, setPageLimit] = useState(SESSION_SEARCH_PAGE_BATCH);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchorSelector) {
      setAnchor(null);
      return;
    }
    const measure = () => {
      const target = document.querySelector(anchorSelector);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const header = target.closest(".workbench-app-bar")?.getBoundingClientRect();
      const app = target.closest(".unified-workbench")?.getBoundingClientRect();
      const width = Math.min(640, (app?.width ?? window.innerWidth) - 16);
      const center = app ? app.left + app.width / 2 : window.innerWidth / 2;
      setAnchor({
        top: Math.max(rect.bottom, header?.bottom ?? 0) + 8,
        left: Math.max(8, Math.min(center - width / 2, window.innerWidth - width - 8)),
        width,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    const target = document.querySelector(anchorSelector);
    if (target) observer.observe(target);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [open, anchorSelector]);

  // Reset the query when the palette closes so it reopens clean.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
      setPageLimit(SESSION_SEARCH_PAGE_BATCH);
    }
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const close = (): void => onOpenChange(false);
  const dismissOnEscape = (event: KeyboardEvent | React.KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const nativeEvent = "nativeEvent" in event ? event.nativeEvent : event;
    if (!isImeCompositionKeyEvent({ nativeEvent })) close();
  };
  const serverInfo = useServerInfo();
  const isAdmin = useIsAdmin();
  const querySettled = query.trim() === debouncedQuery;
  const target = useMemo(
    () =>
      fileTarget
        ? {
            ...fileTarget,
            workspace: fileTarget.workspace ? { ...fileTarget.workspace } : undefined,
          }
        : undefined,
    [fileTarget],
  );
  const fileIdentity = queryIdentity(target?.workspace ?? null, target?.conversationId);
  const filesEnabled =
    open && !sessionsOnly && !!fileIdentity && !!onOpenFile && !!debouncedQuery.trim();
  const fileSearch = useWorkspaceFileSearch(
    target?.conversationId,
    debouncedQuery,
    undefined,
    undefined,
    { enabled: filesEnabled, workspace: target?.workspace ?? null },
    target?.folder ?? "",
  );
  const fileResults =
    filesEnabled && querySettled && !fileSearch.isPlaceholderData && !fileSearch.isError
      ? [
          ...new Map(
            (fileSearch.data?.files ?? [])
              .filter((file) => file.type === "file")
              .map((file) => [file.path, file]),
          ).values(),
        ]
      : [];
  const visibleFiles = fileResults.slice(0, 50);
  const workflowActions = useMemo(
    () =>
      paletteWorkflowActions({
        navigate,
        info: serverInfo,
        isAdmin,
        isDesktop: isElectronShell(),
        isMobile,
        onOpenProjects,
      }),
    [navigate, serverInfo, isAdmin, isMobile, onOpenProjects],
  );

  const actions = useMemo(
    () =>
      mergePaletteCommands(
        suppliedActions ?? searchActions({ navigate, onToggleLeftSidebar, onToggleRightSidebar }),
        [
          ...workflowActions,
          ...(target && fileIdentity && onFileSearch
            ? [
                {
                  id: "search-files",
                  label: "Advanced file search",
                  icon: SearchIcon,
                  keywords: ["files", "contents", "search", "include", "exclude", "glob"],
                  run: () => onFileSearch(query, target),
                },
              ]
            : []),
        ],
      ),
    [
      suppliedActions,
      navigate,
      onToggleLeftSidebar,
      onToggleRightSidebar,
      workflowActions,
      target,
      fileIdentity,
      onFileSearch,
      query,
    ],
  );
  const filteredActions = useMemo(
    () => (sessionsOnly ? [] : filterSearchActions(actions, query)),
    [actions, query, sessionsOnly],
  );

  const { data, isFetching, isError, refetch, hasNextPage, fetchNextPage, isFetchNextPageError } =
    useConversations("", false, { enabled: open });
  const searching = debouncedQuery !== "";
  const titleSearch = useSessionSearch(debouncedQuery, "title", {
    enabled: open && searching && querySettled && sessionsOnly,
    limit: SEARCH_GROUP_PAGE_SIZE,
    cacheIdentity: identity,
  });
  const messageSearch = useMessageSearch(
    debouncedQuery,
    sessionId,
    open && searching && querySettled && !sessionsOnly && (scope === "all" || !!sessionId),
    identity,
    messageFilter,
  );
  useMessageSearchNotice(
    messageSearch,
    open && querySettled && searching && !sessionsOnly,
    `${identity}:${sessionId ?? ""}:${messageFilter}:${debouncedQuery}`,
  );
  const hits = useMemo(
    () =>
      querySettled && searching && !sessionsOnly
        ? searchResults((messageSearch.data?.pages ?? []).flatMap((page) => page.data))
        : [],
    [querySettled, searching, sessionsOnly, messageSearch.data],
  );
  const loadedPages = data?.pages.length ?? 0;
  useEffect(() => {
    if (
      open &&
      sessionsOnly &&
      !query &&
      hasNextPage &&
      loadedPages < pageLimit &&
      !isFetching &&
      !isError &&
      !isFetchNextPageError
    ) {
      void fetchNextPage();
    }
  }, [
    open,
    sessionsOnly,
    query,
    hasNextPage,
    loadedPages,
    pageLimit,
    isFetching,
    isError,
    isFetchNextPageError,
    fetchNextPage,
  ]);

  const sessions = useMemo(() => {
    if (!querySettled) return [];
    if (searching)
      return !sessionsOnly || titleSearch.isPlaceholderData
        ? []
        : paletteSessions(titleSearch.data?.pages ?? []);
    const out = paletteSessions(data?.pages ?? []);
    if (sessionsOnly) return out;
    // The full first page would push Actions below the fold.
    return out.slice(0, IDLE_SESSION_LIMIT);
  }, [
    data,
    titleSearch.data,
    titleSearch.isPlaceholderData,
    querySettled,
    searching,
    sessionsOnly,
  ]);
  const visibleSessions =
    sessionsOnly && !searching ? sessions.slice(0, SESSION_SEARCH_RESULT_LIMIT) : sessions;
  const searchGroups = sessionsOnly ? [titleSearch] : [messageSearch];
  const recentFetching = sessionsOnly && !query && isFetching;
  const loadError = searching
    ? searchGroups.some((group) => group.isError)
    : isError || isFetchNextPageError;
  const loadMoreError = searching
    ? searchGroups.some((group) => group.isFetchNextPageError)
    : isFetchNextPageError;
  const searchFetching = searching && searchGroups.some((group) => group.isFetching);
  const retrying = searching
    ? searchGroups.some((group) => group.isError && group.isFetching)
    : isFetching;
  const retryLoad = (): void => {
    if (!searching) {
      void (isFetchNextPageError ? fetchNextPage() : refetch());
      return;
    }
    for (const group of searchGroups) {
      if (group.isFetchNextPageError) void group.fetchNextPage();
      else if (group.isError) void group.refetch();
    }
  };

  const firstItemValue =
    visibleSessions[0]?.id ??
    (hits[0] ? searchHitKey(hits[0]) : undefined) ??
    (visibleFiles[0] ? `file:${visibleFiles[0].path}` : undefined) ??
    (filteredActions[0] ? `action:${filteredActions[0].id}` : "");
  const [selectedValue, setSelectedValue] = useState("");
  const userMovedSelection = useRef(false);
  useEffect(() => {
    userMovedSelection.current = false;
  }, [open, debouncedQuery, messageFilter, scope]);
  useEffect(() => {
    if (!userMovedSelection.current) setSelectedValue(firstItemValue);
  }, [firstItemValue, open, debouncedQuery]);

  const paletteLabel = sessionsOnly ? "Switch session" : "Command palette";
  const placeholder = sessionsOnly
    ? "Search sessions by name…"
    : fileIdentity
      ? "Search chats, files or commands…"
      : "Search sessions or run a command";

  const runAction = (action: ActionCommand): void => {
    close();
    action.run();
  };

  const goToSession = (id: string): void => {
    close();
    navigate(`/c/${id}`);
  };

  const renderSession = (s: PaletteSession): React.ReactNode => (
    <CommandItem
      key={s.id}
      value={s.id}
      onSelect={() => {
        if (querySettled) goToSession(s.id);
      }}
      className="items-start pl-6"
    >
      <span className="truncate text-left">
        <SearchExcerpt text={s.label} query={debouncedQuery} />
      </span>
    </CommandItem>
  );

  const selectHit = (hit: MessageSearchHit) => {
    if (!querySettled) return;
    if (hit.kind === "chat") {
      // Clear any earlier body activation before opening a title match.
      contextSearch?.goToTitle(hit.session_id);
      close();
      if (!contextSearch) navigate(`/c/${encodeURIComponent(hit.session_id)}`);
      return;
    }
    const range = hit.ranges[0];
    if (!range) return;
    const messageTarget = occurrenceTarget({ hit, range }, 0);
    close();
    if (onMessageSearch)
      onMessageSearch(hit.session_id, debouncedQuery, messageTarget, messageFilter);
    else if (contextSearch) {
      contextSearch.openResult(messageTarget, debouncedQuery, messageFilter);
      navigate(`/c/${encodeURIComponent(hit.session_id)}`);
    }
  };

  const renderShowMore = (
    groupScope: "title",
    group: typeof titleSearch,
    rows: readonly PaletteSession[],
  ): React.ReactNode =>
    group.hasNextPage &&
    !group.isFetchNextPageError && (
      <CommandItem
        value={`more:${groupScope}`}
        disabled={group.isFetchingNextPage}
        onSelect={() => {
          // This row vanishes after the last page, so park the selection on
          // the group's last row; the next ArrowDown reaches the new rows.
          userMovedSelection.current = true;
          const lastRow = rows.at(-1);
          if (lastRow) setSelectedValue(lastRow.id);
          void group.fetchNextPage();
        }}
        className="pl-6 text-muted-foreground"
      >
        {group.isFetchingNextPage ? "Loading…" : "Show more"}
      </CommandItem>
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={!anchorSelector}>
      <DialogContent
        overlay={!anchorSelector}
        aria-describedby={undefined}
        onEscapeKeyDown={dismissOnEscape}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape" || !(event.target instanceof Element)) return;
          if (event.target.closest('[role="dialog"]') !== event.currentTarget) return;
          // A tooltip can consume Radix's document Escape before this dialog sees it.
          dismissOnEscape(event);
        }}
        // Mobile: a top-anchored full-screen sheet sized to --omnigent-viewport-height,
        // so the input and results sit above the soft keyboard. sm:max-w-full
        // overrides DialogContent's sm:max-w-sm between 640px and md.
        className={cn(
          "overflow-hidden p-0",
          anchorSelector
            ? "translate-x-0 translate-y-0 rounded-xl sm:max-w-none"
            : isMobile
              ? "inset-x-0 top-0 h-full max-h-full w-full max-w-full translate-x-0 translate-y-0 gap-0 rounded-none border-0 shadow-none sm:max-w-full"
              : "top-1/4 translate-y-0 rounded-xl sm:max-w-2xl",
        )}
        style={
          anchorSelector
            ? {
                top: anchor?.top ?? 56,
                left: anchor?.left ?? 8,
                width: anchor?.width ?? "calc(100vw - 1rem)",
                maxWidth: "calc(100vw - 1rem)",
                maxHeight: `calc(var(--omnigent-viewport-height, 100dvh) - ${anchor?.top ?? 56}px - 8px)`,
              }
            : isMobile
              ? {
                  top: 0,
                  height: "var(--omnigent-viewport-height, 100dvh)",
                  maxHeight: "var(--omnigent-viewport-height, 100dvh)",
                  // Pad both insets: the macOS title bar or safe-top clears the window
                  // controls or notch; safe-bottom keeps the last row above the home
                  // indicator when the keyboard is closed (the viewport then spans it).
                  paddingTop: "var(--mac-titlebar-height, var(--omnigent-safe-top, 0px))",
                  paddingBottom: "var(--omnigent-safe-bottom, 0px)",
                }
              : undefined
        }
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{paletteLabel}</DialogTitle>
        {/* shouldFilter=false: the server filters sessions and we filter actions
            (see file header). vimBindings=false: keep Ctrl+K/J from doubling as
            list-nav on Win/Linux, where Ctrl+K is also the opener. */}
        {/* Command's base class is `size-full`, so it already fills the sheet. */}
        <Command
          shouldFilter={false}
          vimBindings={false}
          label={paletteLabel}
          value={selectedValue}
          onValueChange={setSelectedValue}
          onKeyDown={(event) => {
            if (SELECTION_KEYS.has(event.key)) userMovedSelection.current = true;
          }}
        >
          {isMobile ? (
            // Search field and an explicit close button share a top row; the
            // full-screen sheet has no ⌘K/Esc affordance the way the desktop
            // dialog does, so the X is how touch users dismiss it.
            <div className="flex items-center gap-1 p-1">
              <div className="min-w-0 flex-1">
                <CommandInput
                  value={query}
                  onValueChange={setQuery}
                  placeholder={placeholder}
                  data-testid="command-palette-input"
                />
              </div>
              <Button
                variant="ghost"
                size="icon-lg"
                className="shrink-0 rounded-full"
                onClick={close}
                aria-label="Close search"
              >
                <XIcon className="size-5 text-muted-foreground" />
              </Button>
            </div>
          ) : (
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={placeholder}
              data-testid="command-palette-input"
            />
          )}
          {!sessionsOnly && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-2">
              <SegmentedControl
                aria-label="Search scope"
                className="h-auto min-h-6 max-w-full flex-wrap"
              >
                {(
                  [
                    ["current", "Current chat"],
                    ["all", "All chats"],
                  ] as const
                ).map(([value, label]) => (
                  <SegmentedControlItem
                    key={value}
                    label={label}
                    active={scope === value}
                    disabled={value === "current" && !contextSearch?.activeSessionId}
                    onClick={() => setScope(value)}
                  >
                    {label}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              <MessageSearchFilterControl value={messageFilter} onChange={setMessageFilter} />
            </div>
          )}
          <CommandList
            data-scrollbar="hidden"
            className={isMobile ? "max-h-none flex-1" : undefined}
            // Hovering a row selects it in cmdk, which counts as the user's pick.
            onPointerMove={(event) => {
              if ((event.target as Element).closest("[cmdk-item]")) {
                userMovedSelection.current = true;
              }
            }}
          >
            {((loadError && (!searching || sessionsOnly)) || recentFetching) && (
              <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                {loadError
                  ? loadMoreError
                    ? "Couldn't load more sessions."
                    : "Couldn't load sessions."
                  : "Loading sessions…"}
                {loadError && (
                  <TooltipButton
                    type="button"
                    className="ml-2 underline"
                    disabled={retrying}
                    onClick={retryLoad}
                  >
                    Retry
                  </TooltipButton>
                )}
              </p>
            )}
            {!loadError &&
              !recentFetching &&
              !(
                filesEnabled &&
                querySettled &&
                !fileSearch.isPlaceholderData &&
                (fileSearch.isError || fileSearch.data?.truncated)
              ) && (
                <CommandEmpty>
                  {searchFetching ||
                  (filesEnabled && (fileSearch.isFetching || fileSearch.isPlaceholderData))
                    ? "Searching…"
                    : "No results found"}
                </CommandEmpty>
              )}
            {sessions.length > 0 && (
              <CommandGroup heading={searching ? undefined : "Sessions"}>
                {visibleSessions.map((session) => renderSession(session))}
                {searching && renderShowMore("title", titleSearch, visibleSessions)}
              </CommandGroup>
            )}
            {hits.length > 0 && (
              <CommandGroup>
                {hits.map((hit) => (
                  <CommandItem
                    key={searchHitKey(hit)}
                    value={searchHitKey(hit)}
                    onSelect={() => selectHit(hit)}
                    className="items-start px-2 py-2"
                  >
                    <SharedSearchResultRow hit={hit} query={debouncedQuery} scope={scope} />
                  </CommandItem>
                ))}
                {messageSearch.hasNextPage && !messageSearch.isFetchNextPageError && (
                  <CommandItem
                    value="more:results"
                    disabled={messageSearch.isFetchingNextPage}
                    onSelect={() => {
                      userMovedSelection.current = true;
                      const last = hits.at(-1);
                      if (last) setSelectedValue(searchHitKey(last));
                      void messageSearch.fetchNextPage();
                    }}
                    className="px-2 text-muted-foreground"
                  >
                    {messageSearch.isFetchingNextPage ? "Loading…" : "Show more"}
                  </CommandItem>
                )}
              </CommandGroup>
            )}
            {filesEnabled && querySettled && fileSearch.isError && (
              <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                Couldn’t search files.
                <TooltipButton
                  type="button"
                  className="ml-2 underline"
                  disabled={fileSearch.isFetching}
                  onClick={() => void fileSearch.refetch()}
                >
                  Retry file search
                </TooltipButton>
              </p>
            )}
            {filesEnabled &&
              (fileSearch.isFetching || fileSearch.isPlaceholderData) &&
              visibleFiles.length === 0 && (
                <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                  Searching files…
                </p>
              )}
            {(visibleFiles.length > 0 ||
              (!sessionsOnly && target && fileIdentity && onFileSearch && query.trim())) && (
              <CommandGroup heading="Files">
                {visibleFiles.map((file) => (
                  <CommandItem
                    key={file.path}
                    value={`file:${file.path}`}
                    onSelect={() => {
                      if (!querySettled || !target || !onOpenFile || fileSearch.isPlaceholderData)
                        return;
                      close();
                      onOpenFile(file.path, target);
                    }}
                  >
                    <FileIcon />
                    <span className="truncate text-left">
                      <SearchExcerpt text={file.path} query={debouncedQuery} />
                    </span>
                  </CommandItem>
                ))}
                {target && onFileSearch && (
                  <CommandItem
                    value="file:advanced"
                    onSelect={() => {
                      close();
                      onFileSearch(query, target);
                    }}
                  >
                    <SearchIcon />
                    Search file contents…
                  </CommandItem>
                )}
              </CommandGroup>
            )}
            {filesEnabled &&
              querySettled &&
              !fileSearch.isPlaceholderData &&
              (fileSearch.data?.truncated || fileResults.length > visibleFiles.length) && (
                <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                  File results are limited. Narrow the query
                  {onFileSearch ? " or use advanced file search" : ""}.
                </p>
              )}
            {sessionsOnly && sessions.length > visibleSessions.length && (
              <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                Showing {visibleSessions.length} of {sessions.length} matches. Type more to narrow
                your search.
              </p>
            )}
            {sessionsOnly && !query && hasNextPage && loadedPages >= pageLimit && !loadError && (
              <Button
                variant="ghost"
                className="w-full"
                disabled={isFetching}
                onClick={() => setPageLimit(loadedPages + SESSION_SEARCH_PAGE_BATCH)}
              >
                Search older sessions
              </Button>
            )}
            {filteredActions.length > 0 && (
              <CommandGroup heading="Actions">
                {filteredActions.map((a) => {
                  const Icon = a.icon;
                  return (
                    <CommandItem key={a.id} value={`action:${a.id}`} onSelect={() => runAction(a)}>
                      <Icon />
                      <span className="flex-1 truncate text-left">{a.label}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
