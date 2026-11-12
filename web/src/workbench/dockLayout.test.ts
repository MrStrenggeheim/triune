// Modified for Triune.
import { describe, expect, it } from "vitest";
import { terminalLayoutGeometry, terminalLayoutKeys } from "@/lib/terminalSplitLayout";
import {
  addDockView,
  closeDockView,
  createDockLayout,
  dockPaneForView,
  focusDockPane,
  moveDockView,
  parseDockLayout,
  resizeDockSplit,
  sameDockResource,
  selectDockView,
  type DockView,
} from "./dockLayout";
import {
  applyDockLayout,
  composeDockLayout,
  createDockPersistence,
  dockStorageKey,
  parseDockPersistence,
  pinDockView,
  retainedDockViews,
  saveDockChatLayout,
  unpinDockView,
} from "./dockPersistence";

const view = (id: string, kind = "editor"): DockView => ({
  id,
  kind,
  title: id,
  resource: { workspaceId: "workspace", path: `/${id}` },
});

describe("dock layout operations", () => {
  it("moves the same view through recursive splits, reorders tabs and collapses empty panes", () => {
    let layout = createDockLayout([view("a"), view("b"), view("c")]);
    layout = moveDockView(layout, "c", { paneId: "main", index: 0 });
    expect(layout.panes[0].viewIds).toEqual(["c", "a", "b"]);
    const original = layout.views.find((item) => item.id === "a");
    layout = moveDockView(layout, "a", { paneId: "main", edge: "right" });
    layout = moveDockView(layout, "b", { paneId: "main", edge: "bottom" });
    expect(layout.tree).toEqual({
      axis: "columns",
      ratio: 0.5,
      children: [{ axis: "rows", ratio: 0.5, children: ["main", "pane-2"] }, "pane-1"],
    });
    expect(parseDockLayout(layout)).toBe(layout);
    layout = moveDockView(layout, "a", { paneId: "pane-2", index: 0 });
    expect(layout.views.find((item) => item.id === "a")).toBe(original);
    expect(layout.panes.find((pane) => pane.id === "pane-2")?.viewIds).toEqual(["a", "b"]);
    expect(layout.tree).toEqual({ axis: "rows", ratio: 0.5, children: ["main", "pane-2"] });
    expect(new Set(layout.views.map((item) => item.id)).size).toBe(3);
    expect(parseDockLayout(layout)).toBe(layout);
  });

  it("splits at all edges and does not limit repeated axes to the old four-cell grid", () => {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      const layout = addDockView(createDockLayout([view("a")]), view("b"), { edge });
      expect(terminalLayoutKeys(layout.tree!)).toEqual(
        edge === "left" || edge === "top" ? ["pane-1", "main"] : ["main", "pane-1"],
      );
    }
    let layout = createDockLayout([view("a")]);
    for (let index = 0; index < 6; index += 1)
      layout = addDockView(layout, view(`extra-${index}`), { edge: "right" });
    expect(layout.panes).toHaveLength(7);
    expect(parseDockLayout(layout)).toBe(layout);
  });

  it("preserves each pane's selected tab when only focus changes", () => {
    let layout = createDockLayout([view("a"), view("b")]);
    layout = addDockView(layout, view("c"), { edge: "right" });
    layout = selectDockView(layout, "b", false);
    expect(layout.focusedPaneId).toBe("pane-1");
    expect(layout.panes.map((pane) => pane.selectedViewId)).toEqual(["b", "c"]);
    const focused = focusDockPane(layout, "main");
    expect(focused.panes).toBe(layout.panes);
    expect(focusDockPane(focused, "missing")).toBe(focused);
  });

  it("closes presentation, chooses a neighboring tab and gives empty pane space to its sibling", () => {
    const shell = view("shell", "terminal");
    let layout = createDockLayout([view("a"), shell, view("c")]);
    layout = selectDockView(layout, "shell");
    layout = closeDockView(layout, "shell");
    expect(layout.panes[0].selectedViewId).toBe("c");
    expect(shell.resource).toEqual({ workspaceId: "workspace", path: "/shell" });
    layout = addDockView(layout, view("d"), { edge: "top" });
    layout = closeDockView(layout, "d");
    expect(layout.tree).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
    layout = closeDockView(closeDockView(layout, "a"), "c");
    expect(layout).toEqual(createDockLayout());
  });

  it("clamps nested resizing, guards invalid paths and maps percentages", () => {
    let layout = addDockView(createDockLayout([view("a")]), view("b"), { edge: "right" });
    layout = addDockView(layout, view("c"), { edge: "bottom" });
    layout = resizeDockSplit(layout, [], 0.6);
    layout = resizeDockSplit(layout, [1], 0.95);
    const panes = terminalLayoutGeometry(layout.tree!).panes;
    expect(panes.map(({ width }) => width)).toEqual([60, 40, 40]);
    for (const [index, height] of [100, 80, 20].entries())
      expect(panes[index].height).toBeCloseTo(height);
    for (const path of [[4], [-1], [1, 0, 1]])
      expect(resizeDockSplit(layout, path, 0.3)).toBe(layout);
    expect(parseDockLayout(resizeDockSplit(layout, [], Number.NaN))).toBeDefined();
  });

  it("rejects conflicting stable IDs while permitting distinct views of the same resource", () => {
    const a = view("a");
    const layout = createDockLayout([a]);
    expect(addDockView(layout, { ...a })).toMatchObject({ views: [a] });
    expect(() => addDockView(layout, { ...a, resource: { path: "/different" } })).toThrow(
      "collision",
    );
    expect(() => addDockView(layout, { ...a, kind: "terminal" })).toThrow("collision");
    expect(addDockView(layout, { ...a, id: "second" }).views).toHaveLength(2);
    expect(
      sameDockResource(
        { ...a, resource: { b: 2, a: { c: 3 } } },
        { ...a, resource: { a: { c: 3 }, b: 2 } },
      ),
    ).toBe(true);
  });

  it("rejects corrupt or unserializable data without replacing a missing resource reference", () => {
    const layout = createDockLayout([view("missing-host")]);
    expect(parseDockLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const invalid of [
      null,
      { ...layout, version: 2 },
      { ...layout, views: [...layout.views, ...layout.views] },
      { ...layout, tree: "absent" },
      { ...layout, focusedPaneId: "absent" },
      { ...layout, panes: [{ ...layout.panes[0], viewIds: ["missing-host", "missing-host"] }] },
      { ...layout, panes: [{ ...layout.panes[0], selectedViewId: "absent" }] },
      { ...layout, tree: { axis: "columns", ratio: 0.5, children: ["main", "main"] } },
      ...[undefined, () => {}, BigInt(1), Number.NaN, new Date(), circular].map((value) => ({
        ...layout,
        views: [{ ...layout.views[0], resource: { value } }],
      })),
    ])
      expect(parseDockLayout(invalid)).toBeUndefined();
    expect(moveDockView(layout, "missing-host", { paneId: "absent" })).toBe(layout);
    expect(moveDockView(layout, "missing-host", { paneId: "main", edge: "right" })).toBe(layout);
  });
});

describe("shared, per-chat and global pin persistence", () => {
  it("reserves pins across A/B/A without altering saved A or the Explorer target", () => {
    const shared = createDockLayout([view("b", "conversation"), view("explorer", "explorer")]);
    let state = createDockPersistence(shared);
    state = saveDockChatLayout(state, "A");
    const a = resizeDockSplit(
      addDockView(createDockLayout([view("a", "conversation")]), view("diff", "diff"), {
        edge: "right",
      }),
      [],
      0.6,
    );
    state = applyDockLayout(state, a);
    const savedA = state.chats[0].layout;
    state = { ...state, activeConversationId: "B", focusedViewId: null };
    state = pinDockView(state, "explorer");
    state = { ...state, activeConversationId: "A" };
    const restored = composeDockLayout(state);
    expect(state.chats[0].layout).toBe(savedA);
    expect(restored.views.map((item) => item.id)).toEqual(["a", "diff", "explorer"]);
    expect(
      terminalLayoutGeometry(restored.tree!).panes.map(({ left, width }) => [left, width]),
    ).toEqual([[0, 100]]);
    expect(restored.views.find((item) => item.id === "explorer")).toEqual(shared.views[1]);
    expect(parseDockPersistence(JSON.stringify(state))).toEqual(state);
    expect(composeDockLayout(parseDockPersistence(JSON.stringify(state))!)).toEqual(restored);
  });

  it("handles same view and pane IDs deterministically and rejects resource collisions", () => {
    const layout = createDockLayout([view("a"), view("explorer")], "main");
    let state = pinDockView(createDockPersistence(layout), "explorer");
    const composed = composeDockLayout(state);
    expect(composed.panes.map((pane) => pane.id)).toEqual(["main"]);
    expect(composed.views.map((item) => item.id)).toEqual(["a", "explorer"]);
    expect(parseDockLayout(composed)).toBe(composed);
    state = applyDockLayout(state, composed);
    expect(composeDockLayout(state)).toEqual(composed);
    const conflicting = {
      ...state,
      chats: [
        {
          conversationId: "other",
          layout: createDockLayout([{ ...view("explorer"), resource: { path: "/other" } }]),
        },
      ],
    };
    expect(() => retainedDockViews(conflicting)).toThrow("collision");
    expect(parseDockPersistence(JSON.stringify(conflicting))).toBeUndefined();
  });

  it("unpins into the current arrangement with the same ID, and persists global moves and resizing", () => {
    let state = pinDockView(
      createDockPersistence(
        addDockView(createDockLayout([view("a")]), view("explorer"), { edge: "right" }),
      ),
      "explorer",
      "right",
    );
    let layout = resizeDockSplit(composeDockLayout(state), [], 0.6);
    state = applyDockLayout(state, layout);
    expect(state.pinRatio).toBeCloseTo(0.4);
    layout = moveDockView(composeDockLayout(state), "explorer", { paneId: "main", edge: "left" });
    state = applyDockLayout(state, layout);
    expect(state.pinEdge).toBe("left");
    const resource = state.pins.views[0];
    state = unpinDockView(state, "explorer");
    expect(state.pins.views).toHaveLength(0);
    expect(composeDockLayout(state).views.filter((item) => item.id === "explorer")).toEqual([
      resource,
    ]);
    expect(dockPaneForView(composeDockLayout(state), "explorer")).toBeDefined();
  });

  it("keeps a pinned tab in its local group; close does not resurrect the local duplicate", () => {
    let state = pinDockView(
      createDockPersistence(createDockLayout([view("a"), view("explorer")])),
      "explorer",
    );
    const moved = moveDockView(composeDockLayout(state), "explorer", { paneId: "main", index: 0 });
    state = applyDockLayout(state, moved);
    expect(composeDockLayout(state).panes).toHaveLength(1);
    expect(state.pinEdge).toBe("right");
    state = applyDockLayout(state, closeDockView(composeDockLayout(state), "explorer"));
    expect(composeDockLayout(state).views.map((item) => item.id)).toEqual(["a"]);
  });

  it("isolates all scope dimensions and rejects malformed versions and duplicate chat saves", () => {
    const scope = { accountId: "a:b", serverId: "server", clientId: "client" };
    const key = dockStorageKey(scope);
    for (const dimension of ["accountId", "serverId", "clientId"] as const)
      expect(dockStorageKey({ ...scope, [dimension]: "other" })).not.toBe(key);
    expect(dockStorageKey({ accountId: "a", serverId: "b:server", clientId: "client" })).not.toBe(
      key,
    );
    expect(() => dockStorageKey({ ...scope, clientId: "" })).toThrow();
    let state = createDockPersistence(createDockLayout([view("a")]));
    state = saveDockChatLayout(state, "__proto__");
    state = saveDockChatLayout(state, "__proto__");
    expect(state.chats).toHaveLength(1);
    expect(parseDockPersistence(JSON.stringify(state))).toEqual(state);
    for (const raw of [
      "bad json",
      "null",
      JSON.stringify({ ...state, version: 2 }),
      JSON.stringify({ ...state, chats: [...state.chats, ...state.chats] }),
      JSON.stringify({ ...state, pinRatio: 0.99 }),
    ])
      expect(parseDockPersistence(raw)).toBeUndefined();
  });
});
