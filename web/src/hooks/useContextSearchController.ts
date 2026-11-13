// Modified for Triune.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getOmnigentServerIdentity } from "@/lib/host";
import { useViewerId } from "./useViewerId";
import { useSessionSearch } from "./useConversations";
import { useMessageSearch } from "./useMessageSearch";
import { useStableCallback } from "./useStableCallback";
import { useShallowStable } from "./useShallowStable";
import { filterSearchActions, searchActions } from "@/shell/contextSearch/actions";
import {
  occurrenceKey,
  occurrenceTarget,
  searchOccurrences,
  targetKey,
  type ContextSearchCategory,
  type ContextSearchScope,
  type ContextSearchTarget,
  type SearchOccurrence,
} from "@/shell/contextSearch/types";

export const CONTEXT_SEARCH_DEBOUNCE_MS = 300;

export function useContextSearchController({
  activeSessionId,
  sidebarOpen,
  setSidebarOpen: setSidebarOpenProp,
  navigate: navigateProp,
  onToggleLeftSidebar: onToggleLeftSidebarProp,
  onToggleRightSidebar: onToggleRightSidebarProp,
  isMobile: isMobileProp,
}: {
  activeSessionId?: string;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  navigate: (path: string, onNavigated: () => void, isRelevant?: () => boolean) => void;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
  isMobile: () => boolean;
}) {
  const setSidebarOpen = useStableCallback(setSidebarOpenProp);
  const navigate = useStableCallback(navigateProp);
  const onToggleLeftSidebar = useStableCallback(onToggleLeftSidebarProp);
  const onToggleRightSidebar = useStableCallback(onToggleRightSidebarProp);
  const isMobile = useStableCallback(isMobileProp);
  const viewerId = useViewerId();
  const identity = `${getOmnigentServerIdentity() ?? ""}:${viewerId ?? ""}`;
  const [owner, setOwner] = useState(identity);
  const [searchOpen, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [scope, setScopeState] = useState<ContextSearchScope>("all");
  const [category, setCategory] = useState<ContextSearchCategory>("all");
  const [highlightTarget, setHighlightTarget] = useState<ContextSearchTarget | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const targetRef = useRef(highlightTarget);
  targetRef.current = highlightTarget;
  const previousSidebarOpen = useRef<boolean | null>(null);
  const requestId = useRef(0);
  const autoJumped = useRef("");
  const open = searchOpen && owner === identity;
  const queryReady = query.trim() === settledQuery;
  const queryIdentity = `${identity}:${scope}:${scope === "current" ? activeSessionId : ""}:${settledQuery}`;
  const liveQueryIdentity = useRef("");
  liveQueryIdentity.current = `${queryIdentity}:${query.trim()}:${open}`;

  useEffect(() => {
    if (owner === identity) return;
    setOwner(identity);
    setOpen(false);
    setQueryState("");
    setSettledQuery("");
    setHighlightTarget(null);
    setUnavailable(null);
    autoJumped.current = "";
    if (previousSidebarOpen.current !== null) setSidebarOpen(previousSidebarOpen.current);
    previousSidebarOpen.current = null;
  }, [owner, identity, setSidebarOpen]);

  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query.trim()), CONTEXT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const openSearch = useCallback(
    (initialScope: ContextSearchScope = "all") => {
      if (!open) {
        previousSidebarOpen.current = sidebarOpen;
        setScopeState(initialScope === "current" && !activeSessionId ? "all" : initialScope);
        setOpen(true);
        autoJumped.current = "";
      }
      setSidebarOpen(true);
      setFocusRequest((value) => value + 1);
    },
    [open, sidebarOpen, activeSessionId, setSidebarOpen],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQueryState("");
    setSettledQuery("");
    setHighlightTarget(null);
    setUnavailable(null);
    autoJumped.current = "";
    if (previousSidebarOpen.current !== null) setSidebarOpen(previousSidebarOpen.current);
    previousSidebarOpen.current = null;
  }, [setSidebarOpen]);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setHighlightTarget(null);
    setUnavailable(null);
    autoJumped.current = "";
  }, []);
  const setScope = useCallback(
    (value: ContextSearchScope) => {
      if (value === scope) return;
      setScopeState(value);
      setHighlightTarget(null);
      setUnavailable(null);
      autoJumped.current = "";
    },
    [scope],
  );

  const messages = useShallowStable(
    useMessageSearch(
      settledQuery,
      scope === "current" ? activeSessionId : undefined,
      open && queryReady && (scope === "all" || !!activeSessionId),
      identity,
    ),
  );
  // All-chat results stay mounted while the active chat gets its own bounded match list.
  const activeMessages = useShallowStable(
    useMessageSearch(
      settledQuery,
      activeSessionId,
      open && queryReady && !!activeSessionId,
      identity,
    ),
  );
  const titles = useShallowStable(
    useSessionSearch(settledQuery, "title", {
      enabled: open && queryReady,
      limit: 8,
      cacheIdentity: identity,
    }),
  );
  const loadedHits = useMemo(() => {
    const seen = new Set<string>();
    return (messages.data?.pages ?? [])
      .flatMap((page) => page.data)
      .filter((hit) => {
        const key = `${hit.session_id}:${hit.item_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [messages.data]);
  const hits = useMemo(() => {
    // Match navigation can reach an active-chat hit beyond the loaded global page.
    const selected =
      highlightTarget && scope === "all"
        ? activeMessages.data?.pages
            .flatMap((page) => page.data)
            .find(
              (hit) =>
                hit.session_id === highlightTarget.conversationId &&
                hit.item_id === highlightTarget.itemId,
            )
        : undefined;
    return selected &&
      !loadedHits.some(
        (hit) => hit.session_id === selected.session_id && hit.item_id === selected.item_id,
      )
      ? [...loadedHits, selected]
      : loadedHits;
  }, [loadedHits, activeMessages.data, highlightTarget, scope]);
  const currentOccurrences = useMemo(
    () =>
      searchOccurrences(
        (activeMessages.data?.pages ?? [])
          .flatMap((page) => page.data)
          .filter((hit) => hit.session_id === activeSessionId),
      ),
    [activeMessages.data, activeSessionId],
  );
  const activeKey = targetKey(highlightTarget);
  const currentIndex = currentOccurrences.findIndex(
    (occurrence) => occurrenceKey(occurrence) === activeKey,
  );

  const activate = useCallback(
    (occurrence: SearchOccurrence, explicit = true) => {
      const generation = liveQueryIdentity.current;
      const apply = () => {
        if (generation !== liveQueryIdentity.current) return;
        setHighlightTarget(occurrenceTarget(occurrence, ++requestId.current));
        setUnavailable(null);
        if (explicit && isMobile()) setSidebarOpen(false);
      };
      if (occurrence.hit.session_id === activeSessionId) apply();
      else if (explicit)
        navigate(
          `/c/${encodeURIComponent(occurrence.hit.session_id)}`,
          apply,
          () => generation === liveQueryIdentity.current,
        );
    },
    [activeSessionId, navigate, isMobile, setSidebarOpen],
  );

  useEffect(() => {
    if (
      !open ||
      !queryReady ||
      !settledQuery ||
      scope !== "current" ||
      !activeMessages.isSuccess ||
      autoJumped.current === queryIdentity
    )
      return;
    autoJumped.current = queryIdentity;
    const first = currentOccurrences[0];
    if (first) activate(first, false);
  }, [
    open,
    queryReady,
    settledQuery,
    scope,
    activeMessages.isSuccess,
    queryIdentity,
    currentOccurrences,
    activate,
  ]);

  const move = useCallback(
    (direction: 1 | -1) => {
      if (!queryReady || !currentOccurrences.length) return;
      const next =
        currentIndex < 0
          ? direction === 1
            ? 0
            : currentOccurrences.length - 1
          : currentIndex + direction;
      if (next >= currentOccurrences.length && activeMessages.hasNextPage) {
        const generation = liveQueryIdentity.current;
        const count = currentOccurrences.length;
        void activeMessages.fetchNextPage().then((result) => {
          if (generation !== liveQueryIdentity.current || result.isError) return;
          const occurrences = searchOccurrences(
            result.data?.pages.flatMap((page) => page.data) ?? [],
          );
          const occurrence = occurrences[count] ?? occurrences[0];
          if (occurrence) activate(occurrence);
        });
        return;
      }
      activate(currentOccurrences[(next + currentOccurrences.length) % currentOccurrences.length]);
    },
    [queryReady, currentOccurrences, currentIndex, activeMessages, activate],
  );

  const onHighlightResolved = useCallback(
    ({ target, status }: { target: ContextSearchTarget; status: "resolved" | "unavailable" }) => {
      const current = targetRef.current;
      if (current?.requestId === target.requestId && targetKey(current) === targetKey(target))
        setUnavailable(
          status === "unavailable" ? "This match is unavailable in the current view." : null,
        );
    },
    [],
  );

  const actions = useMemo(
    () =>
      searchActions({
        navigate: (path) =>
          navigate(path, () => {
            if (isMobile()) setSidebarOpen(false);
          }),
        onToggleLeftSidebar,
        onToggleRightSidebar,
      }),
    [navigate, onToggleLeftSidebar, onToggleRightSidebar, isMobile, setSidebarOpen],
  );
  const filteredActions = useMemo(() => filterSearchActions(actions, query), [actions, query]);
  const goToTitle = useCallback(
    (id: string) => {
      const generation = liveQueryIdentity.current;
      navigate(
        `/c/${encodeURIComponent(id)}`,
        () => {
          if (isMobile()) setSidebarOpen(false);
        },
        () => generation === liveQueryIdentity.current,
      );
    },
    [navigate, isMobile, setSidebarOpen],
  );
  const titleHits = useMemo(() => {
    const seen = new Set<string>();
    return (titles.data?.pages ?? [])
      .flatMap((page) => page.data)
      .filter((hit) => {
        if (hit.archived || seen.has(hit.id)) return false;
        seen.add(hit.id);
        return true;
      });
  }, [titles.data]);

  return useShallowStable({
    open,
    query: owner === identity ? query : "",
    settledQuery: owner === identity ? settledQuery : "",
    scope,
    category,
    setCategory,
    setQuery,
    setScope,
    openSearch,
    close,
    focusRequest,
    hits,
    messages,
    activeMessages,
    titles,
    titleHits,
    highlightTarget: open ? highlightTarget : null,
    onHighlightResolved,
    unavailable,
    activate,
    move,
    currentOccurrences,
    currentIndex,
    actions: filteredActions,
    goToTitle,
    queryReady,
    activeSessionId,
  });
}
