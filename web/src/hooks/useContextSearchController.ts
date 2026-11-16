// Modified for Triune.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useMessageSearch,
  useMessageSearchIdentity,
  useMessageSearchNotice,
} from "./useMessageSearch";
import { useStableCallback } from "./useStableCallback";
import { useShallowStable } from "./useShallowStable";
import {
  occurrenceKey,
  occurrenceTarget,
  searchOccurrences,
  targetKey,
  searchResults,
  type MessageSearchFilter,
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
  isMobile: isMobileProp,
}: {
  activeSessionId?: string;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  navigate: (
    path: string,
    onNavigated: () => void,
    isRelevant?: () => boolean,
    focusComposer?: boolean,
  ) => void;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
  isMobile: () => boolean;
}) {
  const setSidebarOpen = useStableCallback(setSidebarOpenProp);
  const navigate = useStableCallback(navigateProp);
  const isMobile = useStableCallback(isMobileProp);
  const identity = useMessageSearchIdentity();
  const [owner, setOwner] = useState(identity);
  const [searchOpen, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [scope, setScopeState] = useState<ContextSearchScope>("all");
  const [messageFilter, setMessageFilterState] = useState<MessageSearchFilter>("all");
  const [highlightTarget, setHighlightTarget] = useState<ContextSearchTarget | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const targetRef = useRef(highlightTarget);
  targetRef.current = highlightTarget;
  const previousSidebarOpen = useRef<boolean | null>(null);
  const requestId = useRef(0);
  const activationId = useRef(0);
  const pendingResult = useRef<ContextSearchTarget | null>(null);
  const pendingNavigation = useRef<{ destination: string; origin?: string } | null>(null);
  const previousSession = useRef(activeSessionId);
  if (previousSession.current !== activeSessionId) {
    const pending = pendingNavigation.current;
    if (
      !pending ||
      (activeSessionId !== pending.destination && activeSessionId !== pending.origin)
    ) {
      activationId.current += 1;
      pendingNavigation.current = null;
      pendingResult.current = null;
    }
    previousSession.current = activeSessionId;
  }
  const targetLookup = useRef({ requestId: 0, pages: 0 });
  const autoJumped = useRef("");
  const open = searchOpen && owner === identity;
  const queryReady = query.trim() === settledQuery;
  const queryIdentity = `${identity}:${scope}:${scope === "current" ? activeSessionId : ""}:${messageFilter}:${settledQuery}`;
  const liveQueryIdentity = useRef("");
  liveQueryIdentity.current = JSON.stringify([
    identity,
    scope,
    messageFilter,
    settledQuery,
    query.trim(),
    open,
  ]);

  useEffect(() => {
    if (owner === identity) return;
    setOwner(identity);
    setMessageFilterState("all");
    setOpen(false);
    setQueryState("");
    setSettledQuery("");
    setHighlightTarget(null);
    setUnavailable(null);
    autoJumped.current = "";
    activationId.current += 1;
    pendingResult.current = null;
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
        activationId.current += 1;
        pendingResult.current = null;
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
    activationId.current += 1;
    pendingResult.current = null;
    if (previousSidebarOpen.current !== null) setSidebarOpen(previousSidebarOpen.current);
    previousSidebarOpen.current = null;
  }, [setSidebarOpen]);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setHighlightTarget(null);
    setUnavailable(null);
    autoJumped.current = "";
    activationId.current += 1;
    pendingResult.current = null;
  }, []);
  const setScope = useCallback(
    (value: ContextSearchScope) => {
      if (value === scope) return;
      setScopeState(value);
      setHighlightTarget(null);
      setUnavailable(null);
      autoJumped.current = "";
      activationId.current += 1;
      pendingResult.current = null;
    },
    [scope],
  );

  const setMessageFilter = useCallback(
    (value: MessageSearchFilter) => {
      if (value === messageFilter) return;
      setMessageFilterState(value);
      setHighlightTarget(null);
      setUnavailable(null);
      autoJumped.current = "";
      activationId.current += 1;
      pendingResult.current = null;
    },
    [messageFilter],
  );

  const openResult = useCallback(
    (target: ContextSearchTarget, value: string, filter = messageFilter) => {
      if (!open) previousSidebarOpen.current = sidebarOpen;
      const selected = structuredClone(target);
      activationId.current += 1;
      pendingResult.current = selected;
      setQueryState(value);
      setSettledQuery(value.trim());
      setMessageFilterState(filter);
      setOpen(true);
      setSidebarOpen(!isMobile());
      setHighlightTarget({ ...selected, requestId: ++requestId.current });
      setUnavailable(null);
      autoJumped.current = `${identity}:${scope}:${scope === "current" ? target.conversationId : ""}:${filter}:${value.trim()}`;
    },
    [open, sidebarOpen, messageFilter, identity, scope, setSidebarOpen, isMobile],
  );

  const messages = useShallowStable(
    useMessageSearch(
      settledQuery,
      scope === "current" ? activeSessionId : undefined,
      open && queryReady && (scope === "all" || !!activeSessionId),
      identity,
      messageFilter,
    ),
  );
  // All-chat results stay mounted while the active chat gets its own bounded match list.
  const activeMessages = useShallowStable(
    useMessageSearch(
      settledQuery,
      activeSessionId,
      open && queryReady && !!activeSessionId,
      identity,
      messageFilter,
    ),
  );
  useMessageSearchNotice(messages, open && queryReady && !!settledQuery, queryIdentity);
  useMessageSearchNotice(
    activeMessages,
    open && queryReady && !!settledQuery && scope === "all" && !!activeSessionId,
    `${identity}:${activeSessionId}:${messageFilter}:${settledQuery}`,
  );
  const hits = useMemo(
    () => searchResults((messages.data?.pages ?? []).flatMap((page) => page.data)),
    [messages.data],
  );
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
  // A globally selected result may be older than the first active-chat page.
  useEffect(() => {
    if (
      !open ||
      !queryReady ||
      !highlightTarget ||
      highlightTarget.conversationId !== activeSessionId ||
      currentIndex >= 0 ||
      !activeMessages.hasNextPage ||
      activeMessages.isFetching ||
      activeMessages.isError
    )
      return;
    if (targetLookup.current.requestId !== highlightTarget.requestId)
      targetLookup.current = { requestId: highlightTarget.requestId ?? 0, pages: 0 };
    if (targetLookup.current.pages >= 10) return;
    targetLookup.current.pages += 1;
    void activeMessages.fetchNextPage();
  }, [open, queryReady, highlightTarget, activeSessionId, currentIndex, activeMessages]);

  const activate = useCallback(
    (occurrence: SearchOccurrence, explicit = true, focusComposer = explicit) => {
      if (occurrence.hit.kind === "chat" || !queryReady) return;
      const selected = structuredClone(occurrenceTarget(occurrence, 0));
      const generation = liveQueryIdentity.current;
      const activation = ++activationId.current;
      pendingNavigation.current = explicit
        ? { destination: selected.conversationId, origin: activeSessionId }
        : null;
      if (explicit) pendingResult.current = selected;
      const relevant = () =>
        generation === liveQueryIdentity.current && activation === activationId.current;
      let applied = false;
      const apply = () => {
        if (applied || !relevant()) return;
        applied = true;
        pendingNavigation.current = null;
        setHighlightTarget({ ...selected, requestId: ++requestId.current });
        setUnavailable(null);
        if (explicit && isMobile()) setSidebarOpen(false);
      };
      if (explicit)
        navigate(
          `/c/${encodeURIComponent(selected.conversationId)}`,
          apply,
          relevant,
          focusComposer,
        );
      else if (occurrence.hit.session_id === activeSessionId) apply();
    },
    [activeSessionId, navigate, isMobile, setSidebarOpen, queryReady],
  );

  useEffect(() => {
    if (!open || !queryReady || !settledQuery || scope !== "current" || !activeMessages.isSuccess)
      return;
    if (pendingResult.current) {
      if (pendingResult.current.conversationId !== activeSessionId) return;
      pendingResult.current = null;
      autoJumped.current = queryIdentity;
      return;
    }
    if (autoJumped.current === queryIdentity) return;
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
    activeSessionId,
    activate,
  ]);

  const move = useCallback(
    (direction: 1 | -1) => {
      if (!queryReady || activeMessages.isFetchingNextPage) return;
      const count = currentOccurrences.length;
      const next = currentIndex < 0 ? (direction === 1 ? 0 : count - 1) : currentIndex + direction;
      if ((next >= count || next < 0 || !count) && activeMessages.hasNextPage) {
        const generation = liveQueryIdentity.current;
        const activation = ++activationId.current;
        const relevant = () =>
          generation === liveQueryIdentity.current && activation === activationId.current;
        void (async () => {
          // Title-only pages carry no body occurrences; keep looking within a bounded batch.
          for (let page = 0; page < 10 && relevant(); page += 1) {
            // eslint-disable-next-line no-await-in-loop -- Each cursor depends on the preceding page.
            const result = await activeMessages.fetchNextPage();
            if (!relevant() || result.isError) return;
            const occurrences = searchOccurrences(
              result.data?.pages
                .flatMap((entry) => entry.data)
                .filter((hit) => hit.session_id === activeSessionId) ?? [],
            );
            const occurrence = direction === 1 ? occurrences[count] : occurrences.at(-1);
            if ((occurrence && direction === 1) || !result.hasNextPage) {
              const selected = occurrence ?? occurrences[0];
              if (selected) activate(selected, true, false);
              return;
            }
          }
        })();
        return;
      }
      if (count) activate(currentOccurrences[(next + count) % count], true, false);
    },
    [queryReady, currentOccurrences, currentIndex, activeMessages, activeSessionId, activate],
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

  const goToTitle = useCallback(
    (id: string) => {
      setHighlightTarget(null);
      setUnavailable(null);
      pendingResult.current = null;
      autoJumped.current = `${identity}:${scope}:${scope === "current" ? id : ""}:${messageFilter}:${settledQuery}`;
      const activation = ++activationId.current;
      const generation = liveQueryIdentity.current;
      pendingNavigation.current = { destination: id, origin: activeSessionId };
      const relevant = () =>
        generation === liveQueryIdentity.current && activation === activationId.current;
      navigate(
        `/c/${encodeURIComponent(id)}`,
        () => {
          if (!relevant()) return;
          pendingNavigation.current = null;
          if (isMobile()) setSidebarOpen(false);
        },
        relevant,
        true,
      );
    },
    [
      navigate,
      isMobile,
      setSidebarOpen,
      identity,
      scope,
      messageFilter,
      settledQuery,
      activeSessionId,
    ],
  );

  return useShallowStable({
    open,
    query: owner === identity ? query : "",
    settledQuery: owner === identity ? settledQuery : "",
    scope,
    messageFilter,
    setMessageFilter,
    openResult,
    setQuery,
    setScope,
    openSearch,
    close,
    focusRequest,
    hits,
    messages,
    activeMessages,
    highlightTarget: open ? highlightTarget : null,
    onHighlightResolved,
    unavailable,
    activate,
    move,
    currentOccurrences,
    currentIndex,
    goToTitle,
    queryReady,
    activeSessionId,
  });
}
