// Modified for Triune.
import {
  clampSplitRatio,
  replaceTerminalLayoutKey,
  terminalLayoutGeometry,
} from "@/lib/terminalSplitLayout";
import {
  createDockLayout,
  dockPaneForView,
  filterDockLayout,
  parseDockLayout,
  sameDockResource,
  type DockLayout,
  type DockView,
  type SplitEdge,
} from "./dockLayout";

import { composePinnedFrame, withoutEmptyPanes } from "./pinComposition";

export interface DockScope {
  accountId: string;
  serverId: string;
  clientId: string;
}

export interface DockPersistence {
  version: 1;
  /** Absent in legacy saves that used shared-layout fallback. */
  automaticChatLayouts?: true;
  shared: DockLayout;
  chats: { conversationId: string; layout: DockLayout }[];
  pins: DockLayout;
  /** Last composed topology reserves exact pinned-pane positions and sizes. */
  pinFrame?: DockLayout;
  pinFrameOwner?: string | null;
  pinEdge: SplitEdge;
  /** Fraction reserved for global pins. */
  pinRatio: number;
  activeConversationId: string | null;
  focusedViewId: string | null;
}

export function dockStorageKey(scope: DockScope): string {
  if (
    ![scope.accountId, scope.serverId, scope.clientId].every(
      (part) => typeof part === "string" && part.length > 0,
    )
  )
    throw new Error("Dock scope requires account, server and client IDs");
  return `omnigent:dock:v1:${JSON.stringify([scope.accountId, scope.serverId, scope.clientId])}`;
}

export function createDockPersistence(initialLayout = createDockLayout()): DockPersistence {
  if (!parseDockLayout(initialLayout)) throw new Error("Invalid initial dock layout");
  return migrateDockChatLayouts({
    version: 1,
    shared: initialLayout,
    chats: [],
    pins: createDockLayout(),
    pinEdge: "right",
    pinRatio: 0.25,
    activeConversationId: null,
    focusedViewId: null,
  });
}

/** Preserve legacy shared geometry under its owner without replacing explicit saves. */
function migrateDockChatLayouts(state: DockPersistence): DockPersistence {
  if (state.automaticChatLayouts) return state;
  const focused = state.shared.panes.find((pane) => pane.id === state.shared.focusedPaneId);
  const selected = state.shared.views.find((view) => view.id === focused?.selectedViewId);
  const conversation =
    selected?.kind === "conversation"
      ? selected
      : state.shared.views.find((view) => view.kind === "conversation");
  const activeSaved = state.chats.some(
    (chat) => chat.conversationId === state.activeConversationId,
  );
  const owner =
    (activeSaved ? null : state.activeConversationId) ??
    (typeof conversation?.resource.conversationId === "string"
      ? conversation.resource.conversationId
      : null);
  return {
    ...state,
    automaticChatLayouts: true,
    activeConversationId: state.activeConversationId ?? owner,
    chats:
      owner && !state.chats.some((chat) => chat.conversationId === owner)
        ? [...state.chats, { conversationId: owner, layout: state.shared }]
        : state.chats,
  };
}

/** Normal navigation changes the layout owner; explicit addView calls never do. */
export function navigateDockConversation(
  state: DockPersistence,
  conversationId: string | null,
): DockPersistence {
  if (conversationId === "") throw new Error("A conversation ID is required");
  if (conversationId === state.activeConversationId) return state;
  const saved = state.chats.some((chat) => chat.conversationId === conversationId);
  const view = conversationId
    ? (retainedDockViews(state).find(
        (item) => item.kind === "conversation" && item.resource.conversationId === conversationId,
      ) ?? {
        id: `conversation:${conversationId}`,
        kind: "conversation",
        title: "Conversation",
        resource: { conversationId },
      })
    : null;
  return {
    ...state,
    activeConversationId: conversationId,
    focusedViewId: null,
    chats:
      !saved && conversationId && view
        ? [...state.chats, { conversationId, layout: createDockLayout([view]) }]
        : state.chats,
  };
}

export function localDockLayout(state: DockPersistence): DockLayout {
  return (
    state.chats.find((chat) => chat.conversationId === state.activeConversationId)?.layout ??
    state.shared
  );
}

function withLocal(state: DockPersistence, layout: DockLayout): DockPersistence {
  const saved = state.chats.some((chat) => chat.conversationId === state.activeConversationId);
  return saved
    ? {
        ...state,
        chats: state.chats.map((chat) =>
          chat.conversationId === state.activeConversationId ? { ...chat, layout } : chat,
        ),
      }
    : { ...state, shared: layout };
}

/** Saved arrangements share view instances, never conflicting resource identities. */
export function retainedDockViews(state: DockPersistence): DockView[] {
  const views = new Map<string, DockView>();
  for (const layout of [state.shared, ...state.chats.map((chat) => chat.layout), state.pins]) {
    for (const view of layout.views) {
      const existing = views.get(view.id);
      if (existing && !sameDockResource(existing, view))
        throw new Error(`Dock view ID collision: ${view.id}`);
      views.set(view.id, view);
    }
  }
  return [...views.values()];
}

/** Titles change presentation only; preserve resource identity and layout geometry. */
export function updateDockConversationTitles(
  state: DockPersistence,
  titles: ReadonlyMap<string, string>,
): DockPersistence {
  if (!titles.size) return state;
  let changed = false;
  const rename = (layout: DockLayout): DockLayout => {
    let layoutChanged = false;
    const views = layout.views.map((view) => {
      const title =
        view.kind === "conversation" && typeof view.resource.conversationId === "string"
          ? titles.get(view.resource.conversationId)
          : undefined;
      if (!title || title === view.title) return view;
      layoutChanged = true;
      changed = true;
      return { ...view, title };
    });
    return layoutChanged ? { ...layout, views } : layout;
  };
  const shared = rename(state.shared);
  const pins = rename(state.pins);
  const pinFrame = state.pinFrame ? rename(state.pinFrame) : undefined;
  const chats = state.chats.map((chat) => {
    const layout = rename(chat.layout);
    return layout === chat.layout ? chat : { ...chat, layout };
  });
  return changed ? { ...state, shared, pins, pinFrame, chats } : state;
}

/** Pins win duplicate view IDs; pane-name collisions are deterministically renamed. */
export function composeDockLayout(state: DockPersistence): DockLayout {
  retainedDockViews(state);
  const pinned = new Set(state.pins.views.map((view) => view.id));
  const unpinned = filterDockLayout(localDockLayout(state), (view) => !pinned.has(view.id));
  const local = pinned.size ? withoutEmptyPanes(unpinned) : unpinned;
  if (state.pinFrame && pinned.size) {
    const composed = composePinnedFrame(
      state.pinFrame,
      state.pins,
      local,
      state.pinFrameOwner === state.activeConversationId,
    );
    const focused = state.focusedViewId && dockPaneForView(composed, state.focusedViewId);
    return focused ? { ...composed, focusedPaneId: focused.id } : composed;
  }
  let pins = state.pins;
  const used = new Set([...local.panes, ...pins.panes].map((pane) => pane.id));
  for (const pane of pins.panes) {
    if (!local.panes.some((item) => item.id === pane.id)) continue;
    let id = `pin:${pane.id}`;
    while (used.has(id)) id = `pin:${id}`;
    used.add(id);
    pins = {
      ...pins,
      tree: pins.tree === null ? null : replaceTerminalLayoutKey(pins.tree, pane.id, id),
      panes: pins.panes.map((item) => (item.id === pane.id ? { ...item, id } : item)),
      focusedPaneId: pins.focusedPaneId === pane.id ? id : pins.focusedPaneId,
    };
  }
  const before = state.pinEdge === "left" || state.pinEdge === "top";
  const layout: DockLayout = {
    version: 1,
    tree:
      local.tree === null
        ? pins.tree
        : pins.tree === null
          ? local.tree
          : {
              axis: state.pinEdge === "left" || state.pinEdge === "right" ? "columns" : "rows",
              ratio: before ? state.pinRatio : 1 - state.pinRatio,
              children: before ? [pins.tree, local.tree] : [local.tree, pins.tree],
            },
    panes: [...local.panes, ...pins.panes],
    views: [...local.views, ...pins.views],
    focusedPaneId: local.focusedPaneId ?? pins.focusedPaneId,
  };
  const focused = state.focusedViewId && dockPaneForView(layout, state.focusedViewId);
  return focused ? { ...layout, focusedPaneId: focused.id } : layout;
}

/** Editing a composed layout never writes another conversation's snapshot. */
export function applyDockLayout(state: DockPersistence, layout: DockLayout): DockPersistence {
  if (!parseDockLayout(layout)) throw new Error("Invalid dock layout");
  const pinned = new Set(state.pins.views.map((view) => view.id));
  const pins = withoutEmptyPanes(filterDockLayout(layout, (view) => pinned.has(view.id)));
  const unpinned = filterDockLayout(layout, (view) => !pinned.has(view.id));
  const local = pins.views.length ? withoutEmptyPanes(unpinned) : unpinned;
  let pinEdge = state.pinEdge;
  let pinRatio = state.pinRatio;
  // A mixed tab group stays in its respective area; an outer split moves the reservation.
  if (
    layout.tree !== null &&
    typeof layout.tree !== "string" &&
    pins.tree !== null &&
    local.tree !== null
  ) {
    const geometry = terminalLayoutGeometry(layout.tree);
    const pinRects = geometry.panes.filter((rect) =>
      pins.panes.some((pane) => pane.id === rect.key),
    );
    const localRects = geometry.panes.filter((rect) =>
      local.panes.some((pane) => pane.id === rect.key),
    );
    if (pinRects.length && localRects.length) {
      const min = (rects: typeof pinRects, key: "left" | "top") =>
        Math.min(...rects.map((rect) => rect[key]));
      const max = (rects: typeof pinRects, axis: "left" | "top", size: "width" | "height") =>
        Math.max(...rects.map((rect) => rect[axis] + rect[size]));
      if (max(pinRects, "left", "width") <= min(localRects, "left")) {
        pinEdge = "left";
        pinRatio = max(pinRects, "left", "width") / 100;
      } else if (min(pinRects, "left") >= max(localRects, "left", "width")) {
        pinEdge = "right";
        pinRatio = 1 - min(pinRects, "left") / 100;
      } else if (max(pinRects, "top", "height") <= min(localRects, "top")) {
        pinEdge = "top";
        pinRatio = max(pinRects, "top", "height") / 100;
      } else if (min(pinRects, "top") >= max(localRects, "top", "height")) {
        pinEdge = "bottom";
        pinRatio = 1 - min(pinRects, "top") / 100;
      }
    }
  }
  const next = withLocal(
    {
      ...state,
      pins,
      pinFrame: pins.views.length ? layout : undefined,
      pinFrameOwner: pins.views.length ? state.activeConversationId : undefined,
      pinEdge,
      pinRatio: clampSplitRatio(pinRatio),
      focusedViewId:
        layout.panes.find((pane) => pane.id === layout.focusedPaneId)?.selectedViewId ?? null,
    },
    local,
  );
  retainedDockViews(next);
  return next;
}

export function saveDockChatLayout(
  state: DockPersistence,
  conversationId: string,
): DockPersistence {
  if (!conversationId) throw new Error("A conversation ID is required");
  const layout = filterDockLayout(
    composeDockLayout(state),
    (view) => !state.pins.views.some((pin) => pin.id === view.id),
  );
  return {
    ...state,
    activeConversationId: conversationId,
    chats: [
      ...state.chats.filter((chat) => chat.conversationId !== conversationId),
      { conversationId, layout },
    ],
  };
}

export function pinDockView(
  state: DockPersistence,
  viewId: string,
  edge: SplitEdge = state.pinEdge,
): DockPersistence {
  const layout = composeDockLayout(state);
  const view = layout.views.find((item) => item.id === viewId);
  if (!view || state.pins.views.some((item) => item.id === viewId)) return state;
  const ids = new Set([...state.pins.views.map((item) => item.id), viewId]);
  const pins = withoutEmptyPanes(filterDockLayout(layout, (item) => ids.has(item.id)));
  return {
    ...state,
    pins,
    pinEdge: edge,
    pinFrame: layout,
    pinFrameOwner: state.activeConversationId,
  };
}

export function unpinDockView(state: DockPersistence, viewId: string): DockPersistence {
  if (!state.pins.views.some((view) => view.id === viewId)) return state;
  const layout = composeDockLayout(state);
  const pins = withoutEmptyPanes(filterDockLayout(state.pins, (item) => item.id !== viewId));
  return applyDockLayout({ ...state, pins }, layout);
}

export function parseDockPersistence(raw: string): DockPersistence | undefined {
  try {
    const value = JSON.parse(raw) as DockPersistence;
    if (
      !value ||
      value.version !== 1 ||
      !(value.automaticChatLayouts === undefined || value.automaticChatLayouts === true) ||
      !parseDockLayout(value.shared) ||
      !parseDockLayout(value.pins) ||
      (value.pinFrame !== undefined && !parseDockLayout(value.pinFrame)) ||
      !(
        value.pinFrameOwner === undefined ||
        value.pinFrameOwner === null ||
        typeof value.pinFrameOwner === "string"
      ) ||
      !Array.isArray(value.chats) ||
      !["left", "right", "top", "bottom"].includes(value.pinEdge) ||
      !Number.isFinite(value.pinRatio) ||
      clampSplitRatio(value.pinRatio) !== value.pinRatio ||
      !(value.activeConversationId === null || typeof value.activeConversationId === "string") ||
      !(value.focusedViewId === null || typeof value.focusedViewId === "string")
    )
      return undefined;
    const ids = new Set<string>();
    for (const chat of value.chats) {
      if (
        !chat ||
        typeof chat.conversationId !== "string" ||
        !chat.conversationId ||
        ids.has(chat.conversationId) ||
        !parseDockLayout(chat.layout)
      )
        return undefined;
      ids.add(chat.conversationId);
    }
    const retained = new Map(retainedDockViews(value).map((view) => [view.id, view]));
    if (value.pinFrame) {
      if (
        value.pinFrame.views.some(
          (view) => !retained.has(view.id) || !sameDockResource(view, retained.get(view.id)!),
        )
      )
        return undefined;
      if (
        value.pins.views.some(
          (pin) =>
            !value.pinFrame!.views.some(
              (view) => view.id === pin.id && sameDockResource(view, pin),
            ),
        )
      )
        return undefined;
    }
    return migrateDockChatLayouts(value);
  } catch {
    return undefined;
  }
}
