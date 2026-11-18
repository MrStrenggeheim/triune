import { conversationRegistry, type ConversationRegistry } from "@/store/conversationRegistry";
// Modified for Triune.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addDockView,
  arrangeDockViews,
  closeDockView,
  dockPaneForView,
  parseDockLayout,
  sameDockResource,
  selectDockView,
  type DockCloseGuard,
  type DockLayout,
  type DockLayoutUpdate,
  type DockPlacement,
  type DockPreset,
  type DockView,
  type SplitEdge,
} from "./dockLayout";
import {
  applyDockLayout,
  composeDockLayout,
  createDockPersistence,
  dockStorageKey,
  navigateDockConversation,
  parseDockPersistence,
  pinDockView,
  retainedDockViews,
  saveDockChatLayout,
  unpinDockView,
  updateDockConversationTitles,
  type DockPersistence,
  type DockScope,
} from "./dockPersistence";

export type { DockScope } from "./dockPersistence";
export interface DockStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface UseDockLayoutOptions {
  scope: DockScope;
  initialLayout?: DockLayout;
  /** null disables persistence; undefined uses localStorage. */
  storage?: DockStorage | null;
  onBeforeClose?: DockCloseGuard;
  /** Only closed Undo views own heavy history; saved inactive layouts own metadata. */
  undoViews?: readonly DockView[];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function loadSession(
  key: string,
  initialLayout: DockLayout | undefined,
  storage: DockStorage | null | undefined,
) {
  let state = createDockPersistence(initialLayout);
  let error: Error | null = null;
  let resolvedStorage = storage;
  try {
    if (resolvedStorage === undefined)
      resolvedStorage = typeof window === "undefined" ? null : window.localStorage;
    const raw = resolvedStorage?.getItem(key);
    if (raw != null) {
      const parsed = parseDockPersistence(raw);
      if (!parsed) throw new Error("Saved dock layout is invalid or uses an unsupported version");
      state = parsed;
    }
  } catch (cause) {
    error = asError(cause);
  }
  return {
    key,
    state,
    error,
    storage: resolvedStorage ?? null,
    suppliedStorage: storage,
    generation: {},
  };
}

/** Acquire replacements before releasing old owners; saved layouts remain metadata only. */
export function useDockHistoryOwners(
  views: readonly DockView[],
  scopeKey: string,
  registry: ConversationRegistry = conversationRegistry,
): void {
  const leases = useRef(new Map<string, () => void>());
  useLayoutEffect(() => {
    const ids = new Set(
      views.flatMap((view) =>
        typeof view.resource.conversationId === "string" ? [view.resource.conversationId] : [],
      ),
    );
    for (const id of ids) {
      const key = JSON.stringify([scopeKey, id]);
      if (!leases.current.has(key)) leases.current.set(key, registry.retainHistory(id));
    }
  }, [views, scopeKey, registry]);
  // Reopened children acquire mounted leases in passive effects before their parent releases Undo.
  useEffect(() => {
    const ids = new Set(views.map((view) => view.resource.conversationId));
    for (const [key, release] of leases.current) {
      const [scope, id] = JSON.parse(key) as [string, string];
      if (scope !== scopeKey || !ids.has(id)) {
        release();
        leases.current.delete(key);
      }
    }
    registry.trimCleanHistory();
  }, [views, scopeKey, registry]);
  useLayoutEffect(
    () => () => {
      for (const release of leases.current.values()) release();
      leases.current.clear();
    },
    [registry],
  );
}
const NO_UNDO_VIEWS: readonly DockView[] = [];

/** Scope changes reset synchronously so one account never renders another's views. */
export function useDockLayout({
  scope,
  initialLayout,
  storage,
  onBeforeClose,
  undoViews = NO_UNDO_VIEWS,
}: UseDockLayoutOptions) {
  const scopeKey = dockStorageKey(scope);
  useDockHistoryOwners(undoViews, scopeKey);
  const [session, setSession] = useState(() => loadSession(scopeKey, initialLayout, storage));
  // Renders can lag behind commits; only commits and scope resets advance this ref.
  const current = useRef(session);
  const layoutCache = useRef<{ state: DockPersistence; layout: DockLayout } | null>(null);
  const layoutFor = useCallback((state: DockPersistence) => {
    if (layoutCache.current?.state !== state)
      layoutCache.current = { state, layout: composeDockLayout(state) };
    return layoutCache.current.layout;
  }, []);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const guard = useRef(onBeforeClose);
  guard.current = onBeforeClose;
  if (session.key !== scopeKey || session.suppliedStorage !== storage) {
    const next = loadSession(scopeKey, initialLayout, storage);
    current.current = next;
    setSession(next);
  }
  const closing = useRef(new Map<string, Promise<boolean>>());

  const commit = useCallback(
    (change: (state: DockPersistence) => DockPersistence) => {
      const previous = current.current;
      if (!alive.current || previous.key !== scopeKey || previous.suppliedStorage !== storage)
        return;
      const state = change(previous.state);
      if (state === previous.state) return;
      retainedDockViews(state);
      let error: Error | null = null;
      try {
        previous.storage?.setItem(scopeKey, JSON.stringify(state));
      } catch (cause) {
        error = asError(cause);
      }
      const next = { ...previous, state, error };
      current.current = next;
      setSession(next);
    },
    [scopeKey, storage],
  );

  const setLayout = useCallback(
    (update: DockLayoutUpdate) => {
      commit((state) => {
        const layout = layoutFor(state);
        const next = typeof update === "function" ? update(layout) : update;
        return next === layout ? state : applyDockLayout(state, next);
      });
    },
    [commit, layoutFor],
  );

  const addView = useCallback(
    (view: DockView, placement?: DockPlacement) => {
      setLayout((layout) => addDockView(layout, view, placement));
    },
    [setLayout],
  );

  const applyPreset = useCallback(
    (preset: DockPreset) =>
      commit((state) => applyDockLayout(state, arrangeDockViews(layoutFor(state), preset), true)),
    [commit, layoutFor],
  );
  const focusView = useCallback(
    (id: string) => {
      setLayout((layout) => selectDockView(layout, id));
    },
    [setLayout],
  );

  const restoreConversationViews = useCallback(
    (id: string, views: readonly DockView[], placement: DockPlacement = {}) => {
      if (!id) throw new Error("A conversation ID is required");
      commit((state) => {
        const target = navigateDockConversation(state, id);
        const saved = target.chats.find((chat) => chat.conversationId === id);
        const original = saved?.layout ?? state.shared;
        let layout = original;
        let paneId: string | undefined;
        for (const view of views) {
          if (layout.views.some((existing) => existing.id === view.id)) continue;
          layout = addDockView(layout, view, paneId ? { paneId } : placement);
          paneId = dockPaneForView(layout, view.id)?.id;
        }
        if (layout === original && state.chats.some((chat) => chat.conversationId === id))
          return state;
        layout = {
          ...layout,
          focusedPaneId: original.focusedPaneId ?? layout.focusedPaneId,
          panes: layout.panes.map((pane) => {
            const previous = original.panes.find((item) => item.id === pane.id);
            return previous ? { ...pane, selectedViewId: previous.selectedViewId } : pane;
          }),
        };
        return {
          ...state,
          chats: saved
            ? target.chats.map((chat) => (chat.conversationId === id ? { ...chat, layout } : chat))
            : [...state.chats, { conversationId: id, layout }],
        };
      });
    },
    [commit],
  );

  const closeView = useCallback(
    (id: string): Promise<boolean> => {
      const lockKey = JSON.stringify([scopeKey, id]);
      const pending = closing.current.get(lockKey);
      if (pending) return pending;
      const captured = current.current;
      const view = composeDockLayout(captured.state).views.find((item) => item.id === id);
      if (!view || captured.key !== scopeKey) return Promise.resolve(false);
      const task = (async () => {
        if (guard.current && !(await guard.current(view))) return false;
        const latest = current.current;
        if (!alive.current || latest.generation !== captured.generation) return false;
        if (
          latest.state.activeConversationId !== captured.state.activeConversationId &&
          !(
            captured.state.pins.views.some((item) => item.id === id) &&
            latest.state.pins.views.some((item) => item.id === id)
          )
        )
          return false;
        const stillOpen = composeDockLayout(latest.state).views.find((item) => item.id === id);
        if (!stillOpen || !sameDockResource(view, stillOpen)) return false;
        setLayout((layout) => closeDockView(layout, id));
        return true;
      })();
      closing.current.set(lockKey, task);
      void task.then(
        () => closing.current.delete(lockKey),
        () => closing.current.delete(lockKey),
      );
      return task;
    },
    [scopeKey, setLayout],
  );

  const updateView = useCallback(
    async (id: string, patch: Partial<Omit<DockView, "id">>): Promise<boolean> => {
      const captured = current.current;
      if (captured.key !== scopeKey) return false;
      const view = retainedDockViews(captured.state).find((item) => item.id === id);
      if (!view) return false;
      const updated = { ...view, ...patch, id };
      const replacing = !sameDockResource(view, updated);
      // Download provenance changes the menu, not the editable document.
      const onlyOriginalChanged =
        view.kind === "preview" &&
        sameDockResource(
          {
            ...view,
            resource: { ...view.resource, originalAttachment: updated.resource.originalAttachment },
          },
          updated,
        );
      if (replacing && !onlyOriginalChanged && guard.current && !(await guard.current(view)))
        return false;
      const latest = current.current;
      if (!alive.current || latest.generation !== captured.generation) return false;
      const latestView = retainedDockViews(latest.state).find((item) => item.id === id);
      // Focus/resizing can change while the dirty-resource decision is pending.
      // Only an actual replacement of the captured resource invalidates it.
      if (!latestView || !sameDockResource(view, latestView)) return false;
      const accepted = { ...latestView, ...patch, id };
      if (accepted.title === latestView.title && sameDockResource(latestView, accepted))
        return true;
      const replace = (layout: DockLayout): DockLayout => {
        if (!layout.views.some((item) => item.id === id)) return layout;
        const next = {
          ...layout,
          views: layout.views.map((item) => (item.id === id ? accepted : item)),
        };
        if (!parseDockLayout(next)) throw new Error("Invalid dock view update");
        return next;
      };
      commit((state) => ({
        ...state,
        shared: replace(state.shared),
        pins: replace(state.pins),
        pinFrame: state.pinFrame ? replace(state.pinFrame) : undefined,
        chats: state.chats.map((chat) => ({ ...chat, layout: replace(chat.layout) })),
      }));
      return true;
    },
    [commit, scopeKey],
  );

  const navigateConversation = useCallback(
    async (id: string | null): Promise<boolean> => {
      if (id === "") throw new Error("A conversation ID is required");
      const captured = current.current;
      if (!alive.current || captured.key !== scopeKey || captured.suppliedStorage !== storage)
        return false;
      // Navigation retains every saved resource; only close and replacement need a guard.
      commit((state) => navigateDockConversation(state, id));
      return true;
    },
    [commit, scopeKey, storage],
  );

  /** Accepted startup replaces its draft in place, including a now-hidden owner. */
  const promoteConversationDraft = useCallback(
    (viewId: string, id: string, title = "Conversation"): boolean => {
      const captured = current.current;
      if (!alive.current || captured.key !== scopeKey || !id) return false;
      const draft = retainedDockViews(captured.state).find((view) => view.id === viewId);
      if (draft?.kind !== "conversation" || typeof draft.resource.draftId !== "string")
        return false;
      const view: DockView = {
        id: `conversation:${id}`,
        kind: "conversation",
        title,
        resource: { conversationId: id },
      };
      const promote = (layout: DockLayout): DockLayout => {
        if (!layout.views.some((item) => item.id === viewId)) return layout;
        if (layout.views.some((item) => item.id === view.id))
          return selectDockView(closeDockView(layout, viewId), view.id);
        return {
          ...layout,
          views: layout.views.map((item) => (item.id === viewId ? view : item)),
          panes: layout.panes.map((pane) => ({
            ...pane,
            viewIds: pane.viewIds.map((item) => (item === viewId ? view.id : item)),
            selectedViewId: pane.selectedViewId === viewId ? view.id : pane.selectedViewId,
          })),
        };
      };
      commit((state) => ({
        ...state,
        focusedViewId: state.focusedViewId === viewId ? view.id : state.focusedViewId,
        shared: promote(state.shared),
        pins: promote(state.pins),
        pinFrame: state.pinFrame ? promote(state.pinFrame) : undefined,
        chats: state.chats.map((chat) => ({ ...chat, layout: promote(chat.layout) })),
      }));
      return true;
    },
    [commit, scopeKey],
  );

  const useSharedLayout = useCallback(() => navigateConversation(null), [navigateConversation]);
  const updateConversationTitles = useCallback(
    (titles: ReadonlyMap<string, string>) =>
      commit((state) => updateDockConversationTitles(state, titles)),
    [commit],
  );
  const saveChatLayout = useCallback(
    (id: string) => commit((state) => saveDockChatLayout(state, id)),
    [commit],
  );
  const pinView = useCallback(
    (id: string, edge?: SplitEdge) => commit((state) => pinDockView(state, id, edge)),
    [commit],
  );
  const unpinView = useCallback(
    (id: string) => commit((state) => unpinDockView(state, id)),
    [commit],
  );
  // The commit ref can lead a pending React update; render its state snapshot.
  const state = session.state;
  const layout = layoutFor(state);
  const retainedViews = useMemo(() => retainedDockViews(state), [state]);
  return {
    scopeKey,
    layout,
    retainedViews,
    // Saved layouts own resource/reader metadata, not all loaded blocks.
    savedConversationIds: state.chats.map((chat) => chat.conversationId),
    pinnedViewIds: state.pins.views.map((view) => view.id),
    activeConversationId: state.activeConversationId,
    hasChatLayout: state.chats.some((chat) => chat.conversationId === state.activeConversationId),
    error: session.error,
    setLayout,
    applyPreset,
    addView,
    focusView,
    restoreConversationViews,
    closeView,
    updateView,
    updateConversationTitles,
    navigateConversation,
    promoteConversationDraft,
    useSharedLayout,
    saveChatLayout,
    pinView,
    unpinView,
  };
}
