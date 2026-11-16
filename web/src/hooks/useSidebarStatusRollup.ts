// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useMemo } from "react";
import type { SessionActivityDescendant } from "./useConversations";
import { useSessionErrorStates } from "./useSessionErrors";
import { getSessionStates, mergeSessionStates, type SessionState } from "./useSessionState";
import {
  isConversationUnseen,
  isExplicitlyUnread,
  useSeedReadState,
  useUnseenTick,
} from "./useUnseenConversations";
import { hasSessionDraft, useSessionDraftIds, useSessionDraftsHydrated } from "@/lib/sessionDrafts";
import { useChatStore } from "@/store/chatStore";

/** Fold raw authorized metadata, never a child's already-folded display status. */
export function useSidebarStatusRollup(
  descendants: readonly SessionActivityDescendant[],
  activeId: string | undefined,
) {
  const members = useMemo(
    () => [...new Map(descendants.map((row) => [row.id, row])).values()],
    [descendants],
  );
  useSeedReadState(members.length ? members : undefined);
  useUnseenTick(members.length > 0);
  useSessionDraftIds(members.length > 0);
  const draftsHydrated = useSessionDraftsHydrated();
  // Observe already-mounted streams and exact-version tail caches without fetching descendants.
  const errors = useSessionErrorStates(members, { fetchMissing: false });
  const startingId = useChatStore((state) =>
    (state.status === "streaming" || state.terminalPending) &&
    members.some((row) => row.id === state.conversationId)
      ? state.conversationId
      : null,
  );
  const groups: SessionState[][] = [];
  let hasDraft = false;
  let incomplete = members.length > 0 && !draftsHydrated;
  for (const [index, member] of members.entries()) {
    const error = errors[index] !== undefined ? errors[index] : member.latest_error;
    incomplete ||= (error === undefined || error === "unknown") && member.status !== "failed";
    const states = getSessionStates(member, error === "unknown" ? null : (error ?? null));
    if (member.id === startingId && member.status !== "running") states.push({ kind: "starting" });
    if (
      isExplicitlyUnread(member.id) ||
      (member.id !== activeId && isConversationUnseen(member.id, member.updated_at, member.status))
    )
      states.push({ kind: "unseen" });
    hasDraft ||= member.id !== activeId && hasSessionDraft(member.id);
    groups.push(states);
  }
  return { states: mergeSessionStates(...groups), hasDraft, incomplete };
}
