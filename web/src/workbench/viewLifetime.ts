// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useLayoutEffect, useRef, useState } from "react";
import type { DockView } from "./dockLayout";

export const HIDDEN_VIEW_GRACE_MS = 30_000;
const WARM_HIDDEN_GROUPS = 2;

/** These surfaces already keep their recoverable state outside React. */
export function canSuspendDockView(view: DockView): boolean {
  return ["conversation", "files", "changes", "activity"].includes(view.kind);
}

interface ResidentView {
  group: string;
  hiddenAt: number | null;
  recency: number;
}
interface ViewPool {
  residents: Map<string, ResidentView>;
  activeGroup: string;
  revision: number;
}

/** Saved membership is independent of residency; shared view IDs have one resident. */
export function planViewPool(
  previous: ViewPool,
  views: ReadonlyMap<string, DockView>,
  visible: ReadonlySet<string>,
  group: string,
  now: number,
  canSuspend: (view: DockView) => boolean,
): ViewPool {
  const residents = new Map<string, ResidentView>();
  const revision = previous.revision + (previous.activeGroup === group ? 0 : 1);
  for (const [id, resident] of previous.residents) {
    if (!views.has(id)) continue;
    residents.set(id, {
      ...resident,
      hiddenAt: visible.has(id) ? null : (resident.hiddenAt ?? now),
    });
  }
  for (const id of visible) residents.set(id, { group, hiddenAt: null, recency: revision });
  const recentGroups = new Map<string, number>();
  for (const resident of residents.values()) {
    if (resident.hiddenAt === null) continue;
    recentGroups.set(
      resident.group,
      Math.max(recentGroups.get(resident.group) ?? 0, resident.recency),
    );
  }
  const warm = new Set(
    [...recentGroups]
      .sort((a, b) => b[1] - a[1])
      .slice(0, WARM_HIDDEN_GROUPS)
      .map(([id]) => id),
  );
  for (const [id, resident] of residents) {
    if (resident.hiddenAt === null || !canSuspend(views.get(id)!)) continue;
    if (!warm.has(resident.group) || now - resident.hiddenAt >= HIDDEN_VIEW_GRACE_MS)
      residents.delete(id);
  }
  return { residents, activeGroup: group, revision };
}

export function useResidentDockViews(
  views: ReadonlyMap<string, DockView>,
  visible: ReadonlySet<string>,
  layoutKey: string,
  canSuspend = canSuspendDockView,
): DockView[] {
  const committed = useRef<ViewPool>({ residents: new Map(), activeGroup: "", revision: 0 });
  const [, refresh] = useState(0);
  const group = JSON.stringify([layoutKey, [...visible].sort()]);
  const now = Date.now();
  const next = planViewPool(committed.current, views, visible, group, now, canSuspend);
  useLayoutEffect(() => {
    committed.current = next;
    let deadline = Infinity;
    for (const [id, resident] of next.residents) {
      if (resident.hiddenAt === null) continue;
      if (canSuspend(views.get(id)!))
        deadline = Math.min(deadline, resident.hiddenAt + HIDDEN_VIEW_GRACE_MS);
      // A custom model owner may settle a save without changing dock metadata.
      else if (canSuspend !== canSuspendDockView) deadline = Math.min(deadline, now + 1000);
    }
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(() => refresh((value) => value + 1), Math.max(1, deadline - now));
    return () => clearTimeout(timer);
  });
  return [...next.residents.keys()].map((id) => views.get(id)!);
}
