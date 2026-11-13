// Modified for Triune.

import { createContext, useCallback, useEffect, useMemo } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import {
  branchDescendantCounts,
  branchSource,
  type BranchConversation,
} from "@/lib/conversationBranches";
import { useResourceViewState } from "@/lib/panelFolder";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import type { Conversation, ConversationsPage } from "./useConversations";

export interface SidebarBranchState {
  rows: readonly Conversation[];
  descendantCounts: ReadonlyMap<string, number> | null;
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
  activeId?: string;
  openIds: readonly string[];
}
export const SidebarBranchContext = createContext<SidebarBranchState | null>(null);

async function authorizedConversation(id: string): Promise<BranchConversation | null> {
  const response = await authenticatedFetch(`/v1/sessions/${encodeURIComponent(id)}`);
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw await apiErrorFromResponse(response);
  const row = await response.json();
  return {
    ...row,
    object: "conversation",
    labels: row.labels ?? {},
    permission_level: row.permission_level ?? null,
  };
}

/** One shared metadata list, using the authorized branch contract rather than delegation /children. */
export function useConversationBranches({
  enabled,
  rows,
  activeId,
  filter,
  searchQuery,
  openIds = [],
}: {
  enabled: boolean;
  rows: readonly Conversation[];
  activeId?: string;
  filter: string;
  searchQuery: string;
  openIds?: readonly string[];
}) {
  const client = useQueryClient();
  const scope = resourceViewStorageScope();
  const [expanded, setExpanded] = useResourceViewState<ReadonlySet<string>>(
    "sidebar",
    enabled ? "conversation-tree" : undefined,
    "expanded",
    () => new Set(),
  );
  const lineage = useQuery({
    queryKey: ["conversation-branch-lineage", scope, activeId],
    enabled: enabled && !!activeId && !activeId.startsWith("temp:"),
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const known = new Map(rows.map((row) => [row.id, row]));
      const chain: Conversation[] = [];
      const seen = new Set<string>();
      let id: string | undefined = activeId;
      while (id && !seen.has(id) && chain.length < 64) {
        seen.add(id);
        // Each authorized response supplies the next ancestor ID.
        const row: Conversation | null =
          (known.get(id) && "branch" in known.get(id)! ? known.get(id)! : undefined) ??
          // oxlint-disable-next-line no-await-in-loop
          (await client.fetchQuery({
            queryKey: ["conversation-branch-row", scope, id],
            queryFn: () => authorizedConversation(id!),
            staleTime: 30_000,
          }));
        if (!row) break;
        chain.push(row);
        id = branchSource(row);
      }
      return chain.reverse();
    },
  });
  useEffect(() => {
    if (!enabled || !lineage.data?.length) return;
    const ancestors = lineage.data.filter((row) => row.id !== activeId).map((row) => row.id);
    setExpanded((previous) =>
      ancestors.every((id) => previous.has(id)) ? previous : new Set([...previous, ...ancestors]),
    );
  }, [enabled, lineage.data, activeId, setExpanded]);
  const query = useInfiniteQuery({
    queryKey: ["conversation-branches", scope, filter, searchQuery],
    initialPageParam: undefined as string | undefined,
    enabled,
    retry: false,
    staleTime: 15_000,
    refetchInterval: enabled ? 30_000 : false,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        include_side_chats: "true",
        kind: "any",
        limit: "100",
        order: "desc",
        sort_by: "updated_at",
        visibility: filter,
      });
      if (filter === "archived") params.set("include_archived", "true");
      if (searchQuery) params.set("search_query", searchQuery);
      if (pageParam) params.set("after", pageParam);
      const response = await authenticatedFetch(`/v1/sessions?${params}`, { signal });
      if (!response.ok) throw await apiErrorFromResponse(response);
      return (await response.json()) as ConversationsPage;
    },
    getNextPageParam: (page) => (page.has_more && page.last_id ? page.last_id : undefined),
  });
  // Exhaust the authorized, filtered metadata graph without loading histories.
  const { data, hasNextPage, isFetching, isError, fetchNextPage } = query;
  useEffect(() => {
    const pages = data?.pages ?? [];
    const cursor = pages.at(-1)?.last_id;
    if (
      enabled &&
      hasNextPage &&
      !isFetching &&
      !isError &&
      cursor &&
      !data?.pageParams.includes(cursor)
    ) {
      void fetchNextPage();
    }
  }, [enabled, data, hasNextPage, isFetching, isError, fetchNextPage]);
  useEffect(() => {
    if (!enabled) return;
    return client.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success") {
        void client
          .invalidateQueries({ queryKey: ["conversation-branch-row", scope] })
          .then(() =>
            Promise.all([
              client.invalidateQueries({ queryKey: ["conversation-branches", scope] }),
              client.invalidateQueries({ queryKey: ["conversation-branch-lineage", scope] }),
            ]),
          );
      }
    });
  }, [client, enabled, scope]);
  const branchRows = useMemo(() => {
    const result = new Map<string, Conversation>();
    for (const page of query.data?.pages ?? [])
      for (const row of page.data) if (branchSource(row)) result.set(row.id, row);
    for (const row of lineage.data ?? []) {
      // Delegated transcripts open within the owner's layout, not as sidebar roots.
      const parent = (row as Conversation & { parent_session_id?: string }).parent_session_id;
      if (parent && !branchSource(row)) continue;
      result.set(row.id, row);
    }
    // Existing list rows carry optimistic rename/archive/project updates.
    for (const row of rows) result.set(row.id, row);
    return [...result.values()];
  }, [query.data, lineage.data, rows]);
  // Never present a loaded-page count as the total. Retained pages keep counts stable on refresh.
  const descendantCounts = useMemo(
    () =>
      query.data?.pages.at(-1)?.has_more === false ? branchDescendantCounts(branchRows) : null,
    [query.data, branchRows],
  );
  const toggle = useCallback(
    (id: string) =>
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [setExpanded],
  );
  return {
    rows: branchRows,
    descendantCounts,
    ancestors: lineage.data ?? [],
    expanded,
    toggle,
    loading: query.isFetching,
    error: query.error,
    hasMore: query.hasNextPage,
    loadMore: () => {
      void query.fetchNextPage();
    },
    retry: () => {
      void query.refetch();
    },
    activeId,
    openIds,
  };
}
