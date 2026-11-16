// Modified for Triune.
// Per-row state derivation for the sidebar badge.
// Priority: blocking problem > pending question > running > no badge.
//
// Liveness (runner / host reachability) is no longer a sidebar state:
// it surfaces in the open-session view (see `useSessionLiveness`), so the
// sidebar no longer renders a "disconnected" badge and `getSessionState`
// no longer reads runner liveness.
//
// Errors are independent of read state. Native sessions can settle to idle
// after an error, so callers also inspect the latest conversation message.

import type { Conversation } from "@/hooks/useConversations";
import type { LatestSessionError } from "@/lib/sessionError";

export type SessionState =
  | { kind: "awaiting"; count: number }
  | { kind: "running" }
  | { kind: "error" }
  | { kind: "disconnected" }
  | { kind: "unseen" }
  // The open session's launch/relaunch window — a send in flight or the PTY
  // being created before the server confirms `running`. Not derivable from a
  // conversation row (it reads the chat store), so `getSessionState` never
  // returns it; the sidebar row folds it in for the bound session only.
  | { kind: "starting" };

/** Ordered facts let compact surfaces retain lower-priority information in descriptions. */
export function getSessionStates(
  conversation: Pick<Conversation, "status" | "pending_elicitations_count"> | undefined | null,
  latestError: LatestSessionError | null = null,
): SessionState[] {
  const states: SessionState[] = [];
  if (latestError === "disconnected") states.push({ kind: "disconnected" });
  else if (
    latestError !== "recovered_disconnect" &&
    (conversation?.status === "failed" || latestError === "error")
  )
    states.push({ kind: "error" });
  const pending = conversation?.pending_elicitations_count ?? 0;
  if (pending > 0) states.push({ kind: "awaiting", count: pending });
  if (conversation?.status === "running") states.push({ kind: "running" });
  return states;
}

export function getSessionState(
  conversation: Pick<Conversation, "status" | "pending_elicitations_count"> | undefined | null,
  latestError: LatestSessionError | null = null,
): SessionState | null {
  return getSessionStates(conversation, latestError)[0] ?? null;
}

/** Union independent facts; each source session must occur only once. */
export function mergeSessionStates(
  ...groups: readonly (readonly SessionState[])[]
): SessionState[] {
  const states = new Map<SessionState["kind"], SessionState>();
  for (const group of groups) {
    for (const state of group) {
      const previous = states.get(state.kind);
      states.set(
        state.kind,
        state.kind === "awaiting" && previous?.kind === "awaiting"
          ? { kind: "awaiting", count: previous.count + state.count }
          : state,
      );
    }
  }
  return [...states.values()];
}
