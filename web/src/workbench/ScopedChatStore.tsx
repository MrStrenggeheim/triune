// Modified for Triune.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { useStore, type StoreApi, type UseBoundStore } from "zustand";
import { shallow } from "zustand/vanilla/shallow";
import {
  ensureConversationStreamed,
  useChatStore,
  type ChatActions,
  type ChatState,
} from "@/store/chatStore";
import { conversationRegistry } from "@/store/conversationRegistry";
import { refreshConversationObservationPriority } from "@/store/streamObservation";
import { createInitialConversationState, isConversationStateKey } from "@/store/conversationState";

type BoundChatStore = UseBoundStore<StoreApi<ChatState>>;

/** A view reads one registry entry; app-wide queues remain shared and carry their own targets. */
export function createScopedChatStore(conversationId: string): BoundChatStore {
  const empty = { ...createInitialConversationState(), loadingConversation: true };
  const root = () => useChatStore.getState();
  const actions: Partial<ChatActions> = {
    send: (text, agentId, files, options) =>
      root().send(text, agentId, files, { ...options, pinnedConversationId: conversationId }),
    sendSlashCommand: (name, args, agentId, options) =>
      root().sendSlashCommand(name, args, agentId, {
        ...options,
        pinnedConversationId: conversationId,
      }),
    enqueueMessage: (text, files, replyDraft) =>
      root().enqueueMessage(text, files, replyDraft, conversationId),
    maybeFlushQueuedHead: () => root().maybeFlushQueuedHead(conversationId),
    loadMoreHistory: () => root().loadMoreHistory(conversationId),
    refreshSessionState: () => root().refreshSessionState(conversationId),
    submitApproval: (elicitationId, action, content, meta) =>
      root().submitApproval(elicitationId, action, content, meta, conversationId),
    switchTo: async (id) => {
      if (id !== conversationId) throw new Error("A scoped chat cannot change its conversation");
      await ensureConversationStreamed(conversationId);
    },
    stop: () => root().stop(conversationId),
    setEffort: (effort) => root().setEffort(effort, conversationId),
    setModel: (model, options) => root().setModel(model, options, conversationId),
    setCostControlMode: (mode) => root().setCostControlMode(mode, conversationId),
    setSubagentRouting: (mode) => root().setSubagentRouting(mode, conversationId),
    refreshSessionOverrides: () => root().refreshSessionOverrides(conversationId),
    setCodexPlanMode: (enabled) => root().setCodexPlanMode(enabled, conversationId),
    setClaudePermissionMode: (mode) => root().setClaudePermissionMode(mode, conversationId),
    setCodexApprovalMode: (mode) => root().setCodexApprovalMode(mode, conversationId),
    flashUserMessage: (itemId) => root().flashUserMessage(itemId, conversationId),
    addComposerAttachment: (attachment) => root().addComposerAttachment(attachment, conversationId),
    clearPendingComposerAttachments: () => root().clearPendingComposerAttachments(conversationId),
    markRunnerLaunched: () => root().markRunnerLaunched(conversationId),
    compact: () => root().compact(conversationId),
    clearContext: () => root().clearContext(conversationId),
    dismissSandboxAction: (details) => root().dismissSandboxAction(details, conversationId),
    dismissBtwSidechat: () => root().dismissBtwSidechat(conversationId),
  };
  let previousRoot: ChatState | undefined;
  let previousEntry: ReturnType<typeof createInitialConversationState> | undefined;
  let snapshot: ChatState;
  const getState = () => {
    const app = root();
    const entry = conversationRegistry.peek(conversationId)?.getState() ?? empty;
    if (app !== previousRoot || entry !== previousEntry) {
      previousRoot = app;
      previousEntry = entry;
      const next = { ...app, ...entry, ...actions, conversationId };
      // Primary-conversation fields are masked by this entry, so their
      // root-store updates must not notify every other mounted chat.
      if (!snapshot || !shallow(snapshot, next)) snapshot = next;
    }
    return snapshot;
  };
  const api: StoreApi<ChatState> = {
    getState,
    getInitialState: getState,
    setState: (partial) => {
      const patch = typeof partial === "function" ? partial(getState()) : partial;
      if ("conversationId" in patch && patch.conversationId !== conversationId) {
        throw new Error("A scoped chat cannot change its conversation");
      }
      const local: Record<string, unknown> = {};
      const global: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (key === "conversationId") continue;
        if (isConversationStateKey(key)) local[key] = value;
        else global[key] = value;
      }
      if (Object.keys(local).length) {
        const entry = conversationRegistry.peek(conversationId);
        if (!entry) throw new Error("Conversation is not loaded");
        entry.setState(local);
      }
      if (Object.keys(global).length) useChatStore.setState(global);
    },
    subscribe: (listener) => {
      let previous = getState();
      const changed = () => {
        const next = getState();
        if (next === previous) return;
        const before = previous;
        previous = next;
        listener(next, before);
      };
      const unsubscribeRoot = useChatStore.subscribe(changed);
      const unsubscribeEntry = conversationRegistry.subscribe((id) => {
        if (id === conversationId) changed();
      });
      const unsubscribeDisposed = conversationRegistry.subscribeDisposed((id) => {
        if (id === conversationId) changed();
      });
      return () => {
        unsubscribeRoot();
        unsubscribeEntry();
        unsubscribeDisposed();
      };
    },
  };
  const useScopedStore = <T,>(selector: (state: ChatState) => T) => useStore(api, selector);
  return Object.assign(useScopedStore, api) as BoundChatStore;
}

const ScopedChatStoreContext = createContext<BoundChatStore | null>(null);
const ScopedChatFocusContext = createContext(true);
const ScopedChatVisibleContext = createContext(true);
const ScopedChatRootContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function ScopedChatStoreProvider({
  conversationId,
  focused,
  visible = true,
  children,
}: {
  conversationId: string;
  focused: boolean;
  visible?: boolean;
  children: ReactNode;
}) {
  const store = useMemo(() => createScopedChatStore(conversationId), [conversationId]);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const release = conversationRegistry.retain(conversationId, visible, focused);
    refreshConversationObservationPriority();
    if (visible) void ensureConversationStreamed(conversationId);
    return () => {
      release();
      refreshConversationObservationPriority();
    };
  }, [conversationId, visible, focused]);
  return (
    <ScopedChatStoreContext.Provider value={store}>
      <ScopedChatVisibleContext.Provider value={visible}>
        <ScopedChatFocusContext.Provider value={visible && focused}>
          <ScopedChatRootContext.Provider value={root}>
            <div ref={root} className="contents" data-conversation-scope={conversationId}>
              {children}
            </div>
          </ScopedChatRootContext.Provider>
        </ScopedChatFocusContext.Provider>
      </ScopedChatVisibleContext.Provider>
    </ScopedChatStoreContext.Provider>
  );
}

/** Legacy standalone chat keeps its existing store; docked chats bind every action. */
export function useConversationChatStore(): BoundChatStore {
  return useContext(ScopedChatStoreContext) ?? useChatStore;
}

export function useConversationChatFocused(): boolean {
  return useContext(ScopedChatFocusContext);
}

export function useConversationChatVisible(): boolean {
  return useContext(ScopedChatVisibleContext);
}

export function useConversationChatRoot(): RefObject<HTMLDivElement | null> | null {
  return useContext(ScopedChatRootContext);
}

export function useIsScopedConversation(): boolean {
  return useContext(ScopedChatStoreContext) !== null;
}
