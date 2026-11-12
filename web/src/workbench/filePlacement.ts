// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { terminalLayoutGeometry } from "@/lib/terminalSplitLayout";
import type { FileOpeningMode } from "@/lib/fileOpeningPreferences";
import type { DockLayout, DockPlacement } from "./dockLayout";

/** Pick a destination without replacing resources or subdividing every file open. */
export function filePlacement(
  layout: DockLayout,
  originPaneId: string | undefined,
  mode: FileOpeningMode,
  pinnedIds: readonly string[] = [],
): DockPlacement {
  const origin = originPaneId ?? layout.focusedPaneId ?? layout.panes[0]?.id;
  if (!origin || mode === "same") return { paneId: origin };
  if (mode === "split") return { paneId: origin, edge: "right" };
  const rects = layout.tree ? terminalLayoutGeometry(layout.tree).panes : [];
  const from = rects.find((rect) => rect.key === origin);
  const pinned = new Set(pinnedIds);
  const eligible = layout.panes.filter(
    (pane) => pane.id !== origin && !pane.viewIds.some((id) => pinned.has(id)),
  );
  const hasFile = (id: string) =>
    layout.views.some(
      (view) =>
        ["preview", "attachment-preview", "files", "changes", "search"].includes(view.kind) &&
        layout.panes.find((pane) => pane.id === id)?.viewIds.includes(view.id),
    );
  const neighboring = eligible.filter((pane) => {
    const rect = rects.find((item) => item.key === pane.id);
    return (
      from &&
      rect &&
      Math.min(from.top + from.height, rect.top + rect.height) > Math.max(from.top, rect.top) + 1 &&
      (Math.abs(rect.left - (from.left + from.width)) <= 1 ||
        Math.abs(from.left - (rect.left + rect.width)) <= 1)
    );
  });
  const distance = (id: string) => {
    const rect = rects.find((item) => item.key === id);
    return from && rect ? Math.abs(rect.left - from.left) + Math.abs(rect.top - from.top) : 0;
  };
  const candidates = mode === "reuse" ? eligible.filter((pane) => hasFile(pane.id)) : neighboring;
  candidates.sort(
    (a, b) =>
      Number(hasFile(b.id)) - Number(hasFile(a.id)) ||
      distance(a.id) - distance(b.id) ||
      a.id.localeCompare(b.id),
  );
  if (candidates[0]) return { paneId: candidates[0].id };
  return mode === "reuse" ? { paneId: origin } : { paneId: origin, edge: "right" };
}
