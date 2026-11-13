// Modified for Triune.
import { useCallback, useSyncExternalStore } from "react";
import type { ConversationState } from "@/store/chatStore";
import { conversationRegistry } from "@/store/conversationRegistry";
import { createInitialConversationState } from "@/store/conversationState";

// A stable empty snapshot for an id that is not (yet) live, so `getSnapshot`
// returns the same reference across renders and `useSyncExternalStore` doesn't
// loop. `getState()` on a live entry is already reference-stable between
// `setState` calls.
const EMPTY_STATE: ConversationState = createInitialConversationState();

/**
 * Reactively read a *specific* conversation's live state from the registry,
 * regardless of which conversation is on screen.
 *
 * The root `useChatStore` only ever projects the ACTIVE entry, so a side chat
 * rendered beside the main chat (its own tab in the Workspace rail) can't read
 * its transcript through `useChatStore`. This subscribes straight to that
 * conversation's registry entry instead — the same per-conversation state the
 * store routes writes to via `entrySetter`/`setterFor`.
 *
 * Select only the fields the consumer needs; use `useShallow` for composite
 * selections. Omitting the selector retains the whole-state subscription.
 * An absent entry is read from `EMPTY_STATE`.
 *
 * @param id Conversation id to observe, or null for none.
 */
export function useConversationEntryState(id: string | null): ConversationState;
export function useConversationEntryState<T>(
  id: string | null,
  selector: (state: ConversationState) => T,
): T;
export function useConversationEntryState<T>(
  id: string | null,
  selector?: (state: ConversationState) => T,
) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (id === null) return () => {};
      const changed = (changedId: string) => {
        if (changedId === id) onChange();
      };
      const unsubscribe = conversationRegistry.subscribe(changed);
      const unsubscribeDisposed = conversationRegistry.subscribeDisposed(changed);
      return () => {
        unsubscribe();
        unsubscribeDisposed();
      };
    },
    [id],
  );
  const getSnapshot = useCallback(() => {
    const entry = id === null ? undefined : conversationRegistry.peek(id);
    const state = entry === undefined ? EMPTY_STATE : entry.getState();
    return selector ? selector(state) : state;
  }, [id, selector]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
