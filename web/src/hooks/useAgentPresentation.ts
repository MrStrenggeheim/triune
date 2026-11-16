// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useCallback, useContext, useSyncExternalStore } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { conversationRegistry } from "@/store/conversationRegistry";
import type { AnyBlock } from "@/lib/blocks";
import type { ChildSessionInfo } from "./useChildSessions";
import { canonicalSubagentCards, readSubagentActivity } from "@/lib/subagentActivity";
import {
  agentPresentation,
  type AgentPresentationInput,
  type AgentSessionMetadata,
} from "@/lib/agentPresentation";

const cardMaps = new WeakMap<readonly AnyBlock[], Map<string, Record<string, unknown>>>();
function cardFor(blocks: readonly AnyBlock[] | undefined, id: string) {
  if (!blocks) return undefined;
  let cards = cardMaps.get(blocks);
  if (!cards) {
    cards = new Map();
    for (const data of canonicalSubagentCards(blocks).values()) {
      const activity = readSubagentActivity(data);
      if (activity) cards.set(activity.sessionId, data);
    }
    cardMaps.set(blocks, cards);
  }
  return cards.get(id);
}

/** Observe existing authorized caches and the captured parent's cards without fetching or retaining. */
export function useAgentPresentation(
  id: string,
  parentId: string | null,
  input: AgentPresentationInput = {},
) {
  const client = useContext(QueryClientContext);
  const snapshot = useCallback(() => {
    const children = parentId
      ? client?.getQueryData<ChildSessionInfo[]>(["conversation", parentId, "child_sessions"])
      : undefined;
    const child = children?.find((entry) => entry.id === id) ?? input.child;
    const data =
      input.data ??
      cardFor(parentId ? conversationRegistry.peek(parentId)?.getState().blocks : undefined, id);
    const cachedSession =
      client?.getQueryState(["session", id])?.status === "success"
        ? client.getQueryData<AgentSessionMetadata>(["session", id])
        : undefined;
    const session = cachedSession ?? input.session;
    let title = session?.title;
    let updatedAt = client?.getQueryState(["session", id])?.dataUpdatedAt ?? 0;
    for (const query of client?.getQueryCache().getAll() ?? []) {
      if (
        query.state.status !== "success" ||
        !["conversations", "project-sessions", "conversation-branches"].includes(
          String(query.queryKey[0]),
        )
      )
        continue;
      const records = query.state.data as
        | {
            pages?: { data?: { id: string; title?: string | null }[] }[];
            conversations?: { id: string; title?: string | null }[];
            data?: { id: string; title?: string | null }[];
          }
        | undefined;
      const row = [
        ...(records?.pages?.flatMap((page) => page.data ?? []) ?? []),
        ...(records?.conversations ?? []),
        ...(records?.data ?? []),
      ].find((candidate) => candidate.id === id);
      if (row && query.state.dataUpdatedAt >= updatedAt) {
        title = row.title;
        updatedAt = query.state.dataUpdatedAt;
      }
    }
    return JSON.stringify(
      agentPresentation({ ...input, session: { ...session, title }, child, data }),
    );
  }, [client, id, parentId, input]);
  const subscribe = useCallback(
    (notify: () => void) => {
      const cache = client?.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey;
        if (
          (key[0] === "conversation" && key[1] === parentId && key[2] === "child_sessions") ||
          (key[0] === "session" && key[1] === id) ||
          ["conversations", "project-sessions", "conversation-branches"].includes(String(key[0]))
        )
          notify();
      });
      const registry = conversationRegistry.subscribe((changed) => {
        if (changed === parentId) notify();
      });
      const disposed = conversationRegistry.subscribeDisposed((changed) => {
        if (changed === parentId) notify();
      });
      return () => {
        cache?.();
        registry();
        disposed();
      };
    },
    [client, parentId, id],
  );
  return JSON.parse(useSyncExternalStore(subscribe, snapshot, snapshot)) as ReturnType<
    typeof agentPresentation
  >;
}
