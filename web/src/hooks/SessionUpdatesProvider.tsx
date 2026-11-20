// Modified for Triune.
import { SidebarDataContext } from "./useSidebarData";
import {
  PINNED_CONVERSATIONS_KEY,
  type Conversation,
  type PinnedConversationsResult,
} from "./useConversations";
// App-level wiring for the `WS /v1/sessions/updates` push stream.
//
// Mounted once near the app root. It:
//   1. opens the shared session-updates WebSocket for the tab's lifetime,
//   2. derives the watch-set from whatever conversation ids are currently
//      cached across the sidebar's `["conversations", ...]` query variants,
//      and pushes it to the socket, and
//   3. applies incoming snapshot/changed/removed frames back into that cache
//      — patching field changes (status, runner, title, …) in place and
//      falling back to a debounced refetch for structural changes,
//      membership-affecting filter changes, and updated_at resorting where
//      the server's list shape can't be reconstructed locally.
//
// This replaces the old 4 s list poll; `useConversations` keeps low-rate
// HTTP reconciliation so new sessions from other tabs / CLIs are still
// discovered while the socket handles watched-row freshness.

import { type ReactNode, useCallback, useContext, useEffect, useRef } from "react";
import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { getCurrentUserId } from "@/lib/identity";
import { useActiveConversationId } from "@/hooks/useActiveConversationId";
import {
  applyChildFrameRows,
  scheduleChildListRefetch,
  type ChildSessionInfo,
} from "@/hooks/useChildSessions";
import {
  isSessionArchiving,
  isSessionDeleting,
  markRecentlyCreated,
} from "@/hooks/useConversations";
import {
  type ConversationsInfiniteData,
  type SessionListWireItem,
  collectConversationIds,
  filtersFromConversationQueryKey,
  insertNewRowsIntoPages,
  isSubAgentRow,
  mergeItemsIntoPages,
  nullsToUndefined,
  PROJECT_LABEL_KEY,
  removeIdsFromPages,
} from "@/lib/sessionListCache";
import { isModalHostResolved, resolveModalHost } from "@/lib/sessionHost";
import { type SessionUpdatesFrame, sessionUpdatesSocket } from "@/lib/sessionUpdatesSocket";
import { isTempConvId } from "@/lib/tempConversationId";

// Coalesce bursts of structural changes / watch-set recomputes into one
// action. 250 ms is short enough to feel live, long enough to batch the
// flurry of cache writes a single frame can trigger.
const DEBOUNCE_MS = 250;

// A project folder's ["project-sessions", <name>] query is always the
// non-archived, unsearched slice of that project (see useProjectSessions).
// Live frames overlay those caches with these fixed filters so archived rows
// drop out the same way they do from the default sidebar list.
const PROJECT_FOLDER_FILTERS = { searchQuery: "", includeArchived: false } as const;

/**
 * Overlay wire items onto every cached `["conversations", ...]` variant.
 *
 * @param queryClient - The app QueryClient.
 * @param items - Wire items from a snapshot/changed frame.
 * @returns Missing ids, list keys needing a resort, and cross-list membership changes.
 */
function applyItemsToCache(
  queryClient: QueryClient,
  items: SessionListWireItem[],
  activeId: string | undefined,
  viewerId?: string | null,
): { missingIds: string[]; refetchKeys: QueryKey[]; needsMembershipRefetch: boolean } {
  // Frames are full rows with explicit nulls; convert null → undefined so a
  // cleared field overlays the cache in the same shape GET /v1/sessions
  // produces (absent), without tripping the permission_level === null sentinel.
  const itemsById = new Map<string, SessionListWireItem>();
  for (const item of items) {
    if (isSessionDeleting(item.id)) continue;
    itemsById.set(
      item.id,
      nullsToUndefined(isSessionArchiving(item.id) ? { ...item, archived: true } : item),
    );
  }
  const foundAnywhere = new Set<string>();
  const refetchKeys: QueryKey[] = [];
  let needsMembershipRefetch = false;
  const entries = queryClient.getQueriesData<ConversationsInfiniteData>({
    queryKey: ["conversations"],
  });
  for (const [key, data] of entries) {
    if (key[4] === "archived") continue;
    const filters = filtersFromConversationQueryKey(key);
    const {
      data: merged,
      found,
      needsRefetch: queryNeedsRefetch,
      needsMembershipRefetch: queryMembershipChanged,
    } = mergeItemsIntoPages(data, itemsById, filters, activeId);
    for (const id of found) foundAnywhere.add(id);
    if (queryNeedsRefetch) refetchKeys.push(key);
    needsMembershipRefetch ||= queryMembershipChanged;
    // Surface a brand-new watched session (a create here or elsewhere, a share)
    // at the top now, instead of after the debounced refetch (which lags the
    // search index). An unfiled row is fully placed → mark it found so it skips
    // that refetch; a filed row can't be placed in its folder locally → leave it
    // missing so the folder still reconciles via the scheduled refetch.
    const missingHere = new Map([...itemsById].filter(([id]) => !found.has(id)));
    const { data: next, inserted } = insertNewRowsIntoPages(
      merged,
      missingHere,
      filters,
      isSessionDeleting,
      viewerId,
    );
    for (const row of inserted) {
      if (row.project_id == null && !row.labels?.[PROJECT_LABEL_KEY]) foundAnywhere.add(row.id);
      // Keep the new row in the list-fetch until the search index catches up,
      // so the create-path refetch (or any reconcile) can't drop it before it's
      // queryable — otherwise it flashes in and out. Mirrors the delete tombstone.
      markRecentlyCreated(row);
    }
    if (next !== data) queryClient.setQueryData(key, next);
  }
  // Each project folder fetches its own ["project-sessions", <name>] list, so
  // streamed field updates (pending_elicitations_count → "Needs response",
  // status, runner_online, …) must overlay those caches too — otherwise a
  // filed session's row stays frozen at fetch time. Folders are non-archived,
  // unsearched lists; an archived/label-changed row converges via the
  // debounced ["project-sessions"] invalidation the caller schedules.
  const projectEntries = queryClient.getQueriesData<ConversationsInfiniteData>({
    predicate: (query) =>
      ["project-sessions", "conversation-branches"].includes(String(query.queryKey[0])),
  });
  for (const [key, data] of projectEntries) {
    const {
      data: next,
      found,
      needsRefetch: queryNeedsRefetch,
      needsMembershipRefetch: queryMembershipChanged,
    } = mergeItemsIntoPages(data, itemsById, PROJECT_FOLDER_FILTERS, activeId);
    for (const id of found) foundAnywhere.add(id);
    if (queryNeedsRefetch) refetchKeys.push(key);
    needsMembershipRefetch ||= queryMembershipChanged;
    if (next !== data) queryClient.setQueryData(key, next);
  }
  for (const [key, row] of queryClient.getQueriesData<Conversation>({
    queryKey: ["conversation-branch-row"],
  })) {
    if (!row) continue;
    const item = itemsById.get(row.id);
    if (item) {
      foundAnywhere.add(row.id);
      queryClient.setQueryData(key, { ...row, ...item });
    }
  }
  queryClient.setQueryData<PinnedConversationsResult>(PINNED_CONVERSATIONS_KEY, (previous) => {
    if (!previous) return previous;
    let changed = false;
    const conversations = previous.conversations
      .map((row) => {
        const item = itemsById.get(row.id);
        if (!item) return row;
        foundAnywhere.add(row.id);
        changed = true;
        // Pin membership and pin timestamps reconcile through the pinned query.
        return {
          ...row,
          ...item,
          labels: {
            ...(item.labels ?? row.labels),
            ["omnigent.pinned"]: row.labels["omnigent.pinned"],
          },
        };
      })
      .filter((row) => !row.archived);
    return changed ? { ...previous, conversations } : previous;
  });
  // Branch inventories and content searches may gain an off-page child.
  if (refetchKeys.length > 0 && !needsMembershipRefetch) {
    for (const query of queryClient.getQueryCache().findAll({
      predicate: (candidate) =>
        candidate.queryKey[0] === "conversation-branches" || isContentSearchKey(candidate.queryKey),
    }))
      refetchKeys.push(query.queryKey);
  }
  return {
    // A delegated sub-agent belongs to its parent's child list, not to these lists.
    missingIds: [...itemsById.values()]
      .filter((item) => !foundAnywhere.has(item.id) && !isSubAgentRow(item))
      .map((item) => item.id),
    refetchKeys,
    needsMembershipRefetch,
  };
}

/** A `["conversations", <search>, ...]` list whose matches include item content. */
function isContentSearchKey(key: QueryKey): boolean {
  return key[0] === "conversations" && !!key[1];
}

/**
 * Remove ids from every cached `["conversations", ...]` variant.
 *
 * @param queryClient - The app QueryClient.
 * @param ids - Conversation ids to evict.
 * @returns `true` when at least one cached page changed.
 */
function removeIdsFromCache(queryClient: QueryClient, ids: string[]): boolean {
  const idSet = new Set(ids);
  let removedAny = false;
  // Both the global lists and each project folder's own list (same page shape).
  for (const queryKey of [["conversations"], ["project-sessions"], ["conversation-branches"]]) {
    const entries = queryClient.getQueriesData<ConversationsInfiniteData>({ queryKey });
    for (const [key, data] of entries) {
      const { data: next, removed } = removeIdsFromPages(data, idSet);
      if (removed) {
        queryClient.setQueryData(key, next);
        removedAny = true;
      }
    }
  }
  return removedAny;
}

/**
 * Open the session-updates stream and keep the conversations cache in sync
 * with it for as long as the app is mounted.
 *
 * @param children - The app subtree.
 */
export function SessionUpdatesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sidebarData = useContext(SidebarDataContext);
  const identityReady = sidebarData?.identityReady ?? true;
  const sidebarIds = sidebarData?.watchedIds;
  const sidebarIdsRef = useRef(sidebarIds);
  sidebarIdsRef.current = sidebarIds;

  // Last comments fingerprint (`count:updated_at`) seen per session id.
  // A frame whose fingerprint differs from the recorded one means a comment
  // was added, edited, addressed, or deleted somewhere else (another user,
  // the agent's update_comment tool), so the cached comment list is stale.
  // First sight of a session also invalidates: a mutation landing between
  // the comments query's fetch and the socket's first frame would otherwise
  // be swallowed as "baseline" and never surface (a real race on page load
  // when the WS connects slowly). With no comments query mounted the
  // invalidation is a no-op, so the extra firing is free. The map survives
  // socket reconnects, so changes missed while disconnected are caught by
  // the post-reconnect snapshot.
  const commentsFingerprintsRef = useRef(new Map<string, string>());

  // The frame handler is installed once (effect deps are [queryClient]) but
  // the active route changes over the socket's lifetime. Keep the current
  // active id in a ref so the handler always reads the latest without
  // re-subscribing the socket on every navigation.
  const activeId = useActiveConversationId();
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // Recompute the watch-set from the cache and push it to the socket.
  // setWatched no-ops when the id-set is unchanged, so in-place field
  // patches (and navigation between already-watched sessions) don't bounce
  // a new watch-set back to the server.
  const pushWatched = useCallback(() => {
    const entries = queryClient.getQueriesData<ConversationsInfiniteData>({
      queryKey: ["conversations"],
    });
    // Project folders fetch their members into their own caches; include those
    // ids so the server streams liveness (e.g. pending-elicitation "Needs
    // response") for filed sessions that aren't in the global loaded window.
    const projectEntries = queryClient.getQueriesData<ConversationsInfiniteData>({
      predicate: (query) =>
        ["project-sessions", "conversation-branches"].includes(String(query.queryKey[0])),
    });
    const ids = sidebarIdsRef.current
      ? [...sidebarIdsRef.current]
      : collectConversationIds([...entries, ...projectEntries].map(([, data]) => data));
    // Union in the open session. A directly-opened child / sub-agent
    // session is filtered out of the sidebar list, so it's absent from
    // every cached conversations page and wouldn't otherwise be watched —
    // leaving the open-session view with no streamed liveness for it.
    // Adding it here makes the stream push runner_online / host_online for
    // the open session even when it's off-sidebar.
    const active = activeIdRef.current;
    if (active && !ids.includes(active)) ids.push(active);
    // Watch the children of child lists a mounted, enabled view observes
    // (open panes, visible tree levels) so frames patch their rows in place.
    // A retained list rejoins with a fresh snapshot when a view shows it again.
    const observedChildLists = queryClient.getQueryCache().findAll({
      queryKey: ["conversation"],
      predicate: (query) => query.queryKey[2] === "child_sessions" && query.isActive(),
    });
    for (const query of observedChildLists) {
      const childSessions = query.state.data as ChildSessionInfo[] | undefined;
      for (const child of childSessions ?? []) {
        if (!ids.includes(child.id)) ids.push(child.id);
      }
    }
    sessionUpdatesSocket.setWatched(ids.filter((id) => !isTempConvId(id)));
  }, [queryClient]);

  // Navigating to an off-sidebar child changes the open session without
  // touching the conversations cache, so the cache subscription below
  // won't fire. Re-push on activeId change so the open session joins the
  // watch-set (and an already-watched id no-ops via setWatched).
  useEffect(() => {
    pushWatched();
  }, [pushWatched, activeId, sidebarIds]);

  // Freeze the fallback slice key (the modal host over all seen sessions) once
  // the session list first loads, then start the updates socket — which keys
  // its `?omnigent_slice_key=` off that frozen value. Gating start() on the
  // latch (rather than starting eagerly) matters ONLY for this WS: it's a
  // persistent connection, so starting pre-latch (empty map → no key) and then
  // re-keying would force a reconnect. Ordinary `authenticatedFetch` fallback
  // routes (e.g. /v1/hosts) don't gate — they just read the frozen value and a
  // pre-latch miss self-corrects on their next refetch.
  //
  // Latch on the first SUCCESSFUL conversations query, not merely a settled one:
  // the queryFn seeds `_sessionHosts` from every row before it resolves, so a
  // success means the map already reflects this user's hosts (an empty map is
  // then a genuinely zero-session user → null fallback, gate still releases). An
  // error settle is NOT latched — freezing a null key there would pin the page
  // even after a retry loads real hosts; react-query retries the list, and the
  // socket starts on that first success (nothing to stream before the list loads
  // anyway). The session list itself is NOT gated on the modal (it populates the
  // map the modal reads; gating it on the modal would deadlock).
  useEffect(() => {
    if (!identityReady) return;
    let cacheUnsub: (() => void) | null = null;
    const tryResolveAndStart = (): boolean => {
      const succeeded = queryClient
        .getQueryCache()
        .getAll()
        .some(
          (q) =>
            Array.isArray(q.queryKey) &&
            q.queryKey[0] === "conversations" &&
            q.state.status === "success",
        );
      if (!succeeded) return false;
      resolveModalHost();
      sessionUpdatesSocket.start();
      return true;
    };
    // Already succeeded (cache warm from a prior mount)? Start immediately.
    // Otherwise wait for the first success, then start once and unsubscribe.
    if (!tryResolveAndStart()) {
      cacheUnsub = queryClient.getQueryCache().subscribe(() => {
        if (isModalHostResolved() || tryResolveAndStart()) cacheUnsub?.();
      });
    }

    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
    let reconcileMembership = false;
    const pendingKeys = new Map<string, QueryKey>();
    const scheduleInvalidate = (keys?: QueryKey[]) => {
      if (keys === undefined) reconcileMembership = true;
      for (const key of keys ?? []) {
        const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
        if (query) pendingKeys.set(query.queryHash, key);
      }
      if (invalidateTimer !== null) return;
      invalidateTimer = setTimeout(() => {
        invalidateTimer = null;
        if (reconcileMembership) {
          // Membership can change in a list where the row was absent.
          void queryClient.invalidateQueries({
            queryKey: ["conversations"],
            predicate: (query) => query.meta?.snapshot !== true,
          });
          void queryClient.invalidateQueries({ queryKey: ["project-sessions"] });
          void queryClient.invalidateQueries({ queryKey: ["conversation-branches"] });
          void queryClient.invalidateQueries({ queryKey: ["archived-project-names"] });
        } else {
          for (const key of pendingKeys.values()) {
            void queryClient.invalidateQueries({
              queryKey: key,
              exact: true,
              predicate: (query) => query.meta?.snapshot !== true,
            });
          }
        }
        pendingKeys.clear();
        reconcileMembership = false;
      }, DEBOUNCE_MS);
    };

    // See commentsFingerprintsRef: invalidate `["comments", id]` (prefix —
    // covers the per-file variants too) when a session's fingerprint moves.
    const syncCommentsFingerprints = (items: SessionListWireItem[]) => {
      for (const item of items) {
        // `?? 0` folds the wire `null` (no comments) and an older server's
        // absent field into the same baseline shape.
        const fingerprint = `${item.comments_count ?? 0}:${item.comments_updated_at ?? 0}`;
        const previous = commentsFingerprintsRef.current.get(item.id);
        commentsFingerprintsRef.current.set(item.id, fingerprint);
        if (previous !== fingerprint) {
          void queryClient.invalidateQueries({ queryKey: ["comments", item.id] });
        }
      }
    };

    let projectsDirty = false;
    const refreshProjects = () => {
      if (!projectsDirty || queryClient.isMutating({ mutationKey: ["project-order"] }) > 0) return;
      projectsDirty = false;
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["project-order"] });
    };
    // Replay changes after all saves, including their settlement refetches, finish.
    const unsubscribeMutations = queryClient.getMutationCache().subscribe(refreshProjects);

    const unsubscribeFrames = sessionUpdatesSocket.subscribe((frame: SessionUpdatesFrame) => {
      switch (frame.type) {
        case "heartbeat":
          return;
        case "hosts_changed":
          void queryClient.invalidateQueries({ queryKey: ["hosts"] });
          void queryClient.invalidateQueries({ queryKey: ["session-agent"] });
          return;
        case "projects_changed":
          // Another client created/renamed/deleted a project (or changed its
          // config/icon). Only the mutating client invalidates locally, so
          // refresh the project-row caches here to converge without a reload.
          projectsDirty = true;
          refreshProjects();
          void queryClient.invalidateQueries({ queryKey: ["project-config"] });
          return;
        case "removed":
          for (const id of frame.ids) commentsFingerprintsRef.current.delete(id);
          queryClient.setQueryData<PinnedConversationsResult>(
            PINNED_CONVERSATIONS_KEY,
            (previous) =>
              previous
                ? {
                    ...previous,
                    conversations: previous.conversations.filter(
                      (row) => !frame.ids.includes(row.id),
                    ),
                  }
                : previous,
          );
          if (removeIdsFromCache(queryClient, frame.ids)) scheduleInvalidate();
          return;
        case "snapshot":
        case "changed": {
          syncCommentsFingerprints(frame.items);
          if (frame.type === "snapshot") {
            // A snapshot restates the full watch-set, so fingerprints for
            // sessions outside it are de-watched leftovers — prune them to
            // keep the map bounded. A pruned session that re-enters the
            // watch-set re-baselines via the first-sight invalidation.
            const watchedIds = new Set(frame.items.map((item) => item.id));
            for (const id of commentsFingerprintsRef.current.keys()) {
              if (!watchedIds.has(id)) commentsFingerprintsRef.current.delete(id);
            }
          }
          // Child rows carry parent_session_id: patch the parent's cached
          // child list in place, and refetch it (coalesced) only for what the
          // frame cannot supply, such as an unknown child or a final preview.
          for (const parentId of applyChildFrameRows(queryClient, frame.items)) {
            scheduleChildListRefetch(queryClient, parentId);
          }
          const { missingIds, refetchKeys, needsMembershipRefetch } = applyItemsToCache(
            queryClient,
            frame.items,
            activeIdRef.current,
            getCurrentUserId(),
          );
          // A watched id absent from every page is a new session whose sort
          // position we can't place locally. Membership-affecting deltas
          // (archive/search/connected filters) and updated_at resorting need
          // the same server-side reconciliation.
          //
          // Skip the active session: its updated_at bumps on open before the
          // initial list fetch returns, so it lands in missingIds even though
          // it isn't a genuinely new session. Its data is covered by
          // useSession and it's pinned in the sidebar via ActiveChatOverride.
          const sidebarMissingIds = activeIdRef.current
            ? missingIds.filter((id) => id !== activeIdRef.current)
            : missingIds;
          // A changed sub-agent row is patched in its parent's child list; only
          // an active content search can gain a match from its new content.
          const searchKeys =
            frame.type === "changed" && frame.items.some(isSubAgentRow)
              ? queryClient
                  .getQueryCache()
                  .findAll({ predicate: (query) => isContentSearchKey(query.queryKey) })
                  .map((query) => query.queryKey)
              : [];
          if (sidebarMissingIds.length > 0 || needsMembershipRefetch) scheduleInvalidate();
          else if (refetchKeys.length + searchKeys.length > 0)
            scheduleInvalidate([...refetchKeys, ...searchKeys]);
          return;
        }
      }
    });

    // Recompute the watch-set from the cache whenever a conversations query
    // changes (initial fetch, fallback refetch, pagination, our own splices).
    let watchTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleWatch = () => {
      if (watchTimer !== null) return;
      watchTimer = setTimeout(() => {
        watchTimer = null;
        pushWatched();
      }, DEBOUNCE_MS);
    };

    pushWatched();
    const cache = queryClient.getQueryCache();
    const unsubscribeCache = cache.subscribe((event) => {
      const key = event.query.queryKey;
      // Recompute the watch-set when either the global list or a project
      // folder's list changes (fetch, pagination, splice) so newly loaded
      // folder members join the stream's watch-set.
      if (
        Array.isArray(key) &&
        (key[0] === "conversations" ||
          key[0] === "project-sessions" ||
          key[0] === "conversation-branches")
      ) {
        scheduleWatch();
      }
      // Also recompute when a child-sessions list loads or a view starts or
      // stops observing it, so only shown tree levels stay in the watch-set.
      if (Array.isArray(key) && key[0] === "conversation" && key[2] === "child_sessions") {
        scheduleWatch();
      }
    });

    return () => {
      unsubscribeFrames();
      unsubscribeMutations();
      unsubscribeCache();
      if (invalidateTimer !== null) clearTimeout(invalidateTimer);
      if (watchTimer !== null) clearTimeout(watchTimer);
      sessionUpdatesSocket.stop();
    };
  }, [identityReady, queryClient, pushWatched]);

  return children;
}
