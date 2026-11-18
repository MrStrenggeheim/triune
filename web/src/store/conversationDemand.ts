// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import { conversationRegistry } from "./conversationRegistry";
import { ensureConversationStreamed } from "./chatStore";
import { refreshConversationObservationPriority } from "./streamObservation";

interface Demand {
  id: string;
  scope: string;
  ready: boolean;
  focused: boolean;
}

const views = new Map<symbol, Demand>();
const memberships = new Map<
  string,
  { release: () => void; unfocus?: () => void; opened: boolean }
>();
let scheduled = false;

function reconcile(): void {
  scheduled = false;
  const wanted = new Map<string, Demand>();
  for (const demand of views.values()) {
    if (demand.scope !== resourceViewStorageScope()) continue;
    const key = JSON.stringify([demand.scope, demand.id]);
    const existing = wanted.get(key);
    wanted.set(key, {
      scope: demand.scope,
      id: demand.id,
      ready: demand.ready || !!existing?.ready,
      focused: demand.focused || !!existing?.focused,
    });
  }
  for (const [id, member] of memberships) {
    if (wanted.has(id)) continue;
    member.unfocus?.();
    member.release();
    memberships.delete(id);
  }
  for (const [key, demand] of wanted) {
    const id = demand.id;
    let member = memberships.get(key);
    if (!member) {
      member = { release: conversationRegistry.retain(id, true, false), opened: false };
      memberships.set(key, member);
    }
    if (demand.focused && !member.unfocus) member.unfocus = conversationRegistry.retainFocus(id);
    if (!demand.focused && member.unfocus) {
      member.unfocus();
      member.unfocus = undefined;
    }
    if (demand.ready && !member.opened) {
      member.opened = true;
      void ensureConversationStreamed(id).catch((error: unknown) => {
        if (memberships.get(key) !== member) return;
        conversationRegistry.peek(id)?.setState({
          loadingConversation: false,
          conversationLoadError: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }
  }
  refreshConversationObservationPriority();
}

/** React may release and reacquire the same resource in one layout commit. */
export function declareConversationDemand(owner: symbol, demand?: Demand): void {
  if (demand) views.set(owner, demand);
  else views.delete(owner);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(reconcile);
  }
}
