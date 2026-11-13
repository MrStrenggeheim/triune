// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DockView } from "./dockLayout";
import { canSuspendDockView, HIDDEN_VIEW_GRACE_MS, useResidentDockViews } from "./viewLifetime";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps static protected models without scheduling a periodic check", () => {
  vi.useFakeTimers();
  const editor: DockView = { id: "editor", title: "Editor", kind: "preview", resource: {} };
  const inventory = new Map([[editor.id, editor]]);
  const { result, rerender } = renderHook(
    ({ visible }) => useResidentDockViews(inventory, visible, "layout"),
    { initialProps: { visible: new Set([editor.id]) } },
  );
  rerender({ visible: new Set<string>() });
  act(() => vi.advanceTimersByTime(HIDDEN_VIEW_GRACE_MS * 2));
  expect(result.current).toEqual([editor]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["preview", "search", "terminal", "browser", "automations", "logs", "extension"])(
  "protects %s until its model owner explicitly supports retirement",
  (kind) => {
    expect(canSuspendDockView({ id: kind, kind, title: kind, resource: {} })).toBe(false);
  },
);
