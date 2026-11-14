// Modified for Triune.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef } from "react";
import { authenticatedFetch } from "@/lib/identity";
import { getOmnigentServerIdentity } from "@/lib/host";
import { SEARCH_FETCH_TIMEOUT_MS } from "./useConversations";
import { useViewerId } from "./useViewerId";
import { useNotificationNotice } from "./useNotificationNotice";
import type { MessageSearchFilter, MessageSearchPage } from "@/shell/contextSearch/types";

export function useMessageSearchIdentity() {
  const viewerId = useViewerId();
  return `${getOmnigentServerIdentity() ?? ""}:${viewerId ?? ""}`;
}

export class MessageSearchError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 404 || status === 501
        ? "Message search is unavailable on this server."
        : "Couldn't search messages.",
    );
    this.status = status;
  }
}

export async function fetchMessageSearch({
  query,
  sessionId,
  cursor,
  signal,
  messageFilter = "all",
}: {
  query: string;
  sessionId?: string;
  cursor?: string;
  signal: AbortSignal;
  messageFilter?: MessageSearchFilter;
}): Promise<MessageSearchPage> {
  const params = new URLSearchParams({
    query,
    limit: "40",
    message_filter: messageFilter,
    include_titles: String(!sessionId),
  });
  if (sessionId) {
    params.set("session_id", sessionId);
    params.set("include_archived", "true");
  }
  if (cursor) params.set("cursor", cursor);
  const response = await authenticatedFetch(`/v1/sessions/search/messages?${params}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS)]),
  });
  if (!response.ok) throw new MessageSearchError(response.status);
  return response.json() as Promise<MessageSearchPage>;
}

export function useMessageSearch(
  query: string,
  sessionId: string | undefined,
  enabled: boolean,
  identity: string,
  messageFilter: MessageSearchFilter = "all",
) {
  return useInfiniteQuery({
    queryKey: ["message-search", identity, query, sessionId ?? null, messageFilter, !sessionId],
    queryFn: ({ pageParam, signal }) =>
      fetchMessageSearch({ query, sessionId, cursor: pageParam, signal, messageFilter }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more ? (page.next_cursor ?? undefined) : undefined),
    enabled: enabled && query.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 30_000,
  });
}

/** View-owned feedback retires retry actions when the query, identity or view changes. */
export function useMessageSearchNotice(
  search: ReturnType<typeof useMessageSearch>,
  enabled: boolean,
  queryIdentity: string,
) {
  const id = useId();
  const { isError, error, isFetchNextPageError, fetchNextPage, refetch } = search;
  const current = useRef({ enabled, queryIdentity });
  current.current = { enabled, queryIdentity };
  useEffect(() => {
    current.current = { enabled, queryIdentity };
    return () => {
      current.current.enabled = false;
    };
  }, [enabled, queryIdentity]);
  const notice = useMemo(() => {
    if (!enabled || !isError) return null;
    return {
      title: error instanceof MessageSearchError ? error.message : "Couldn't search messages.",
      type: "error" as const,
      action: {
        label: "Retry",
        onClick: () => {
          if (!current.current.enabled || current.current.queryIdentity !== queryIdentity) return;
          void (isFetchNextPageError ? fetchNextPage() : refetch());
        },
      },
    };
  }, [enabled, queryIdentity, isError, error, isFetchNextPageError, fetchNextPage, refetch]);
  useNotificationNotice(`message-search:${id}:${queryIdentity}`, notice);
}
