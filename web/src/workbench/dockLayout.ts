// Modified for Triune.
import type { SplitEdge } from "@/grid/gridLayout";
import {
  clampSplitRatio,
  removeTerminalLayoutKey,
  resizeTerminalSplit,
  terminalLayoutKeys,
  type TerminalLayout,
} from "@/lib/terminalSplitLayout";

export type { SplitEdge };
export interface DockView {
  id: string;
  kind: string;
  title: string;
  /** Explicit resource identity; only JSON data may be persisted. */
  resource: Record<string, unknown>;
}

export interface DockPane {
  id: string;
  viewIds: string[];
  selectedViewId: string | null;
}

export interface DockLayout {
  version: 1;
  /** columns = horizontal split; rows = vertical split. */
  tree: TerminalLayout | null;
  panes: DockPane[];
  views: DockView[];
  focusedPaneId: string | null;
}

export interface DockPlacement {
  paneId?: string;
  edge?: SplitEdge;
  index?: number;
}

export type DockLayoutUpdate = DockLayout | ((layout: DockLayout) => DockLayout);
export type DockCloseGuard = (view: DockView) => boolean | Promise<boolean>;

export function createDockLayout(views: DockView[] = [], paneId = "main"): DockLayout {
  const layout: DockLayout = {
    version: 1,
    tree: views.length ? paneId : null,
    panes: views.length
      ? [{ id: paneId, viewIds: views.map((view) => view.id), selectedViewId: views[0].id }]
      : [],
    views,
    focusedPaneId: views.length ? paneId : null,
  };
  if (!parseDockLayout(layout)) throw new Error("Invalid dock views");
  return layout;
}

export function dockPaneForView(layout: DockLayout, viewId: string): DockPane | undefined {
  return layout.panes.find((pane) => pane.viewIds.includes(viewId));
}

export function focusDockPane(layout: DockLayout, paneId: string): DockLayout {
  return layout.focusedPaneId === paneId || !layout.panes.some((pane) => pane.id === paneId)
    ? layout
    : { ...layout, focusedPaneId: paneId };
}

export function selectDockView(layout: DockLayout, viewId: string, focus = true): DockLayout {
  const pane = dockPaneForView(layout, viewId);
  if (!pane || (pane.selectedViewId === viewId && (!focus || layout.focusedPaneId === pane.id)))
    return layout;
  return {
    ...layout,
    focusedPaneId: focus ? pane.id : layout.focusedPaneId,
    panes: layout.panes.map((item) => (item === pane ? { ...item, selectedViewId: viewId } : item)),
  };
}

/** Removes presentation only; resource lifecycle belongs to the caller. */
export function closeDockView(layout: DockLayout, viewId: string): DockLayout {
  const pane = dockPaneForView(layout, viewId);
  if (!pane) return layout;
  const index = pane.viewIds.indexOf(viewId);
  const viewIds = pane.viewIds.filter((id) => id !== viewId);
  const panes = viewIds.length
    ? layout.panes.map((item) =>
        item === pane
          ? {
              ...pane,
              viewIds,
              selectedViewId:
                pane.selectedViewId === viewId
                  ? viewIds[Math.min(index, viewIds.length - 1)]
                  : pane.selectedViewId,
            }
          : item,
      )
    : layout.panes.filter((item) => item !== pane);
  const tree =
    viewIds.length || layout.tree === null
      ? layout.tree
      : removeTerminalLayoutKey(layout.tree, pane.id);
  return {
    ...layout,
    tree,
    panes,
    views: layout.views.filter((view) => view.id !== viewId),
    focusedPaneId: panes.some((item) => item.id === layout.focusedPaneId)
      ? layout.focusedPaneId
      : tree === null
        ? null
        : terminalLayoutKeys(tree)[0],
  };
}

function freshPaneId(layout: DockLayout): string {
  const ids = new Set(layout.panes.map((pane) => pane.id));
  let index = 1;
  while (ids.has(`pane-${index}`)) index += 1;
  return `pane-${index}`;
}

function splitAt(
  tree: TerminalLayout,
  target: string,
  next: string,
  edge: SplitEdge,
): TerminalLayout {
  if (typeof tree === "string") {
    if (tree !== target) return tree;
    return {
      axis: edge === "left" || edge === "right" ? "columns" : "rows",
      ratio: 0.5,
      children: edge === "left" || edge === "top" ? [next, tree] : [tree, next],
    };
  }
  return {
    ...tree,
    children: [
      splitAt(tree.children[0], target, next, edge),
      splitAt(tree.children[1], target, next, edge),
    ],
  };
}

/** A stable ID cannot silently change resource or kind during an open/move. */
export function sameDockResource(first: DockView, second: DockView): boolean {
  return first.kind === second.kind && jsonKey(first.resource) === jsonKey(second.resource);
}

function jsonKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonKey).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jsonKey(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function addDockView(
  layout: DockLayout,
  view: DockView,
  placement: DockPlacement = {},
): DockLayout {
  if (!validView(view)) throw new Error("Dock views require a stable ID and JSON resource");
  const existing = layout.views.find((item) => item.id === view.id);
  if (existing) {
    if (!sameDockResource(existing, view)) throw new Error(`Dock view ID collision: ${view.id}`);
    return Object.keys(placement).length
      ? moveDockView(layout, view.id, placement)
      : selectDockView(layout, view.id);
  }
  const target = placement.paneId ?? layout.focusedPaneId ?? layout.panes[0]?.id;
  if (layout.tree === null) return createDockLayout([view], placement.paneId ?? "main");
  if (target && !layout.panes.some((pane) => pane.id === target)) return layout;
  if (placement.edge && target) {
    const paneId = freshPaneId(layout);
    return {
      ...layout,
      tree: splitAt(layout.tree, target, paneId, placement.edge),
      panes: [...layout.panes, { id: paneId, viewIds: [view.id], selectedViewId: view.id }],
      views: [...layout.views, view],
      focusedPaneId: paneId,
    };
  }
  return {
    ...layout,
    views: [...layout.views, view],
    focusedPaneId: target ?? null,
    panes: layout.panes.map((pane) => {
      if (pane.id !== target) return pane;
      const viewIds = [...pane.viewIds];
      viewIds.splice(tabIndex(placement.index, viewIds.length), 0, view.id);
      return { ...pane, viewIds, selectedViewId: view.id };
    }),
  };
}

function tabIndex(index: number | undefined, length: number): number {
  return index === undefined || !Number.isFinite(index)
    ? length
    : Math.max(0, Math.min(length, Math.trunc(index)));
}

/** index refers to the final tab order, after removing the dragged tab. */
export function moveDockView(
  layout: DockLayout,
  viewId: string,
  placement: DockPlacement,
): DockLayout {
  const source = dockPaneForView(layout, viewId);
  const view = layout.views.find((item) => item.id === viewId);
  const target = placement.paneId ?? layout.focusedPaneId;
  if (!source || !view || !target || !layout.panes.some((pane) => pane.id === target))
    return layout;
  if (source.id === target && source.viewIds.length === 1) return layout;
  const removed = closeDockView(layout, viewId);
  return addDockView(removed, view, { ...placement, paneId: target });
}

export function resizeDockSplit(
  layout: DockLayout,
  path: readonly number[],
  ratio: number,
): DockLayout {
  if (layout.tree === null) return layout;
  let node = layout.tree;
  for (const index of path) {
    if (typeof node === "string" || (index !== 0 && index !== 1)) return layout;
    node = node.children[index];
  }
  if (typeof node === "string") return layout;
  return { ...layout, tree: resizeTerminalSplit(layout.tree, path, ratio) };
}

/** Keeps geometry and selection for a subset, collapsing empty branches. */
export function filterDockLayout(
  layout: DockLayout,
  keep: (view: DockView) => boolean,
): DockLayout {
  return layout.views.reduce(
    (current, view) => (keep(view) ? current : closeDockView(current, view.id)),
    layout,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJson(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 64 || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  const next = new Set(ancestors).add(value);
  return Object.values(value).every((item) => isJson(item, next, depth + 1));
}

function validView(value: unknown): value is DockView {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    !!value.id &&
    typeof value.kind === "string" &&
    !!value.kind &&
    typeof value.title === "string" &&
    isRecord(value.resource) &&
    isJson(value.resource)
  );
}

/** Rejects corrupt/unknown versions without retargeting unavailable resources. */
export function parseDockLayout(value: unknown): DockLayout | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.views) ||
    !Array.isArray(value.panes)
  )
    return undefined;
  if (!value.views.every(validView)) return undefined;
  const viewIds = new Set(value.views.map((view) => view.id));
  if (viewIds.size !== value.views.length) return undefined;
  const usedViews = new Set<string>();
  const paneIds = new Set<string>();
  for (const pane of value.panes) {
    if (
      !isRecord(pane) ||
      typeof pane.id !== "string" ||
      !pane.id ||
      paneIds.has(pane.id) ||
      !Array.isArray(pane.viewIds) ||
      (pane.viewIds.length
        ? !pane.viewIds.includes(pane.selectedViewId)
        : pane.selectedViewId !== null)
    )
      return undefined;
    paneIds.add(pane.id);
    for (const id of pane.viewIds) {
      if (typeof id !== "string" || !viewIds.has(id) || usedViews.has(id)) return undefined;
      usedViews.add(id);
    }
  }
  if (usedViews.size !== viewIds.size) return undefined;
  if (value.tree === null)
    return paneIds.size === 0 && value.focusedPaneId === null
      ? (value as unknown as DockLayout)
      : undefined;
  const leaves = new Set<string>();
  const validTree = (node: unknown, depth: number): boolean => {
    if (typeof node === "string") {
      if (!paneIds.has(node) || leaves.has(node)) return false;
      leaves.add(node);
      return true;
    }
    return (
      depth < 64 &&
      isRecord(node) &&
      (node.axis === "rows" || node.axis === "columns") &&
      typeof node.ratio === "number" &&
      Number.isFinite(node.ratio) &&
      clampSplitRatio(node.ratio) === node.ratio &&
      Array.isArray(node.children) &&
      node.children.length === 2 &&
      node.children.every((child) => validTree(child, depth + 1))
    );
  };
  if (
    !validTree(value.tree, 0) ||
    leaves.size !== paneIds.size ||
    typeof value.focusedPaneId !== "string" ||
    !paneIds.has(value.focusedPaneId)
  )
    return undefined;
  return value as unknown as DockLayout;
}
