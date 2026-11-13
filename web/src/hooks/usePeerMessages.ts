// Modified for Triune.
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useViewerId } from "@/hooks/useViewerId";
import { authenticatedFetch } from "@/lib/identity";
import { getOmnigentServerIdentity } from "@/lib/host";
import { ApiError, apiErrorFromResponse, fetchSessionItemsPage } from "@/lib/sessionsApi";
import { isTempConvId } from "@/lib/tempConversationId";
import { readMessageCommunication, type MessageCommunication } from "@/lib/messageCommunication";
import type { MessageContentBlock } from "@/lib/blocks";
import { conversationRegistry } from "@/store/conversationRegistry";
import { createInitialConversationState } from "@/store/conversationState";

export interface PeerActivityMessage {
  id: string;
  communication: MessageCommunication;
  content: MessageContentBlock[];
  direction: "incoming" | "outgoing";
}

interface PeerMessagePage {
  data: PeerActivityMessage[];
  last_id: string | null;
  has_more: boolean;
}

const emptyConversation = createInitialConversationState();

/** Subscribe to the named registry entry, including eviction and access revocation. */
export function useActivityConversationState(conversationId: string | null) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const changed = (id: string) => {
        if (id === conversationId) notify();
      };
      const removeChanged = conversationRegistry.subscribe(changed);
      const removeDisposed = conversationRegistry.subscribeDisposed(changed);
      return () => {
        removeChanged();
        removeDisposed();
      };
    },
    [conversationId],
  );
  const snapshot = useCallback(
    () =>
      conversationId
        ? (conversationRegistry.peek(conversationId)?.getState() ?? emptyConversation)
        : emptyConversation,
    [conversationId],
  );
  return useSyncExternalStore(subscribe, snapshot, () => emptyConversation);
}

export async function fetchPeerMessages(
  conversationId: string,
  after: string | null,
  signal?: AbortSignal,
): Promise<PeerMessagePage> {
  const query = new URLSearchParams({ limit: "100" });
  if (after) query.set("after", after);
  const response = await authenticatedFetch(
    `/v1/sessions/${encodeURIComponent(conversationId)}/peer-messages?${query}`,
    { signal },
  );
  if (!response.ok) throw await apiErrorFromResponse(response);
  const page = await response.json();
  if (
    !page ||
    !Array.isArray(page.data) ||
    typeof page.has_more !== "boolean" ||
    (page.has_more && (typeof page.last_id !== "string" || !page.last_id || page.last_id === after))
  )
    throw new Error("Invalid peer message pagination");
  const data: PeerActivityMessage[] = [];
  for (const item of page.data) {
    const communication = readMessageCommunication(item?.communication);
    if (
      !communication ||
      communication.kind !== "peer" ||
      communication.source_conversation_id !== conversationId ||
      typeof item.id !== "string" ||
      !Array.isArray(item.content)
    )
      continue;
    const content: MessageContentBlock[] = item.content.filter((block: unknown) => {
      if (!block || typeof block !== "object") return false;
      const value = block as Record<string, unknown>;
      return value.type === "input_text" || value.type === "output_text"
        ? typeof value.text === "string"
        : ["input_image", "input_file", "output_image", "output_file"].includes(String(value.type));
    });
    data.push({ id: item.id, content, communication, direction: "outgoing" });
  }
  return {
    data,
    last_id: typeof page.last_id === "string" ? page.last_id : null,
    has_more: page.has_more,
  };
}

/** Read one bounded transcript page; cursor progress follows all items, not just peer text. */
export async function fetchIncomingPeerMessages(
  conversationId: string,
  after: string | null,
  signal?: AbortSignal,
): Promise<PeerMessagePage> {
  const page = await fetchSessionItemsPage(conversationId, {
    olderThan: after ?? undefined,
    limit: 100,
    signal,
  });
  // The shared API helper reverses descending server pages into chronological order.
  const lastId = page.items[0]?.id ?? null;
  if (
    typeof page.hasMore !== "boolean" ||
    (page.hasMore && (typeof lastId !== "string" || !lastId || lastId === after))
  )
    throw new Error("Invalid incoming message pagination");
  const data: PeerActivityMessage[] = [];
  for (const item of [...page.items].reverse()) {
    if (
      item.type !== "message" ||
      item.role !== "user" ||
      typeof item.id !== "string" ||
      !item.id ||
      !Array.isArray(item.content)
    )
      continue;
    const communication = readMessageCommunication(item.communication);
    if (!communication || communication.destination_conversation_id !== conversationId) continue;
    const content: MessageContentBlock[] = item.content.filter((block: unknown) => {
      if (!block || typeof block !== "object") return false;
      const value = block as Record<string, unknown>;
      return value.type === "input_text" || value.type === "output_text"
        ? typeof value.text === "string"
        : ["input_image", "input_file", "output_image", "output_file"].includes(String(value.type));
    });
    data.push({ id: item.id, content, communication, direction: "incoming" });
  }
  return { data, last_id: lastId, has_more: page.hasMore };
}

export function peerActivityKey(message: PeerActivityMessage): string {
  return JSON.stringify([
    message.communication.source_conversation_id,
    message.communication.destination_conversation_id,
    message.communication.message_id,
  ]);
}

/** Outbox pages are explicit; empty transcript pages may still have a next cursor. */
export function usePeerMessages(
  conversationId: string | null,
  options: { enabled?: boolean } = {},
) {
  const accountId = useViewerId();
  const serverId = getOmnigentServerIdentity();
  const sessionId = conversationId && !isTempConvId(conversationId) ? conversationId : null;
  const authorizedScope = !!sessionId && !!accountId && !!serverId;
  const state = useActivityConversationState(authorizedScope ? sessionId : null);
  const authority = JSON.stringify([accountId, serverId]);
  const [registryScope, setRegistryScope] = useState(() => ({
    authority,
    excludedEntries: new Set<ReturnType<typeof conversationRegistry.all>[number]>(),
  }));
  if (registryScope.authority !== authority) {
    // Existing registry entries have no account/server stamp; never reuse them across a switch.
    setRegistryScope({ authority, excludedEntries: new Set(conversationRegistry.all()) });
  }
  const liveEntry = sessionId ? conversationRegistry.peek(sessionId) : undefined;
  const includeLive =
    registryScope.authority === authority &&
    (!liveEntry || !registryScope.excludedEntries.has(liveEntry));
  const incomingHistory = useInfiniteQuery({
    queryKey: ["peer-messages", "incoming", accountId, serverId, sessionId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      if (!sessionId || !accountId || !serverId)
        throw new Error("Activity authority is unresolved");
      return fetchIncomingPeerMessages(sessionId, pageParam, signal);
    },
    getNextPageParam: (page, pages) =>
      page.has_more && !pages.slice(0, -1).some((older) => older.last_id === page.last_id)
        ? page.last_id
        : undefined,
    enabled: options.enabled !== false && authorizedScope,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
  const outgoing = useInfiniteQuery({
    queryKey: ["peer-messages", accountId, serverId, sessionId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchPeerMessages(sessionId!, pageParam, signal),
    getNextPageParam: (page, pages) =>
      page.has_more && !pages.slice(0, -1).some((older) => older.last_id === page.last_id)
        ? page.last_id
        : undefined,
    enabled: options.enabled !== false && authorizedScope,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
  const deniedError = [outgoing.error, incomingHistory.error].find(
    (error) => error instanceof ApiError && [401, 403, 404].includes(error.status),
  );
  const accessDenied = !!deniedError;
  const messages = useMemo(() => {
    if (!authorizedScope || accessDenied) return [];
    const merged = new Map<string, PeerActivityMessage>();
    for (const page of incomingHistory.data?.pages ?? []) {
      for (const message of page.data) {
        const key = peerActivityKey(message);
        if (!merged.has(key)) merged.set(key, message);
      }
    }
    // A successful read in this scope admits live data; a cold registry alone is not authority.
    for (const block of includeLive && incomingHistory.data ? state.blocks : []) {
      if (
        block.type !== "user_message" ||
        !block.communication ||
        block.communication.destination_conversation_id !== sessionId
      )
        continue;
      const communication = readMessageCommunication(block.communication);
      if (!communication) continue;
      const message: PeerActivityMessage = {
        id: block.ctx.itemId ?? communication.message_id,
        communication,
        content: block.content,
        direction: "incoming",
      };
      merged.set(peerActivityKey(message), message);
    }
    for (const page of outgoing.data?.pages ?? []) {
      for (const message of page.data) {
        const key = peerActivityKey(message);
        // Newest page wins duplicate outbox entries; incoming self-messages become outgoing.
        if (merged.get(key)?.direction !== "outgoing") merged.set(key, message);
      }
    }
    return [...merged.values()].sort(
      (first, second) => (second.communication.sent_at ?? 0) - (first.communication.sent_at ?? 0),
    );
  }, [
    state.blocks,
    sessionId,
    outgoing.data,
    incomingHistory.data,
    accessDenied,
    authorizedScope,
    includeLive,
  ]);
  const refetch = () =>
    authorizedScope
      ? Promise.all([outgoing.refetch(), incomingHistory.refetch()])
      : Promise.resolve([]);
  return {
    ...outgoing,
    // Existing outbox cursors/load-more stay independent of transcript pagination.
    incomingHistory,
    messages,
    refetch,
    isLoading: outgoing.isLoading || incomingHistory.isLoading,
    isFetching: outgoing.isFetching || incomingHistory.isFetching,
    isError: outgoing.isError || incomingHistory.isError,
    isSuccess: outgoing.isSuccess && incomingHistory.isSuccess,
    error: deniedError ?? incomingHistory.error ?? outgoing.error,
  };
}
