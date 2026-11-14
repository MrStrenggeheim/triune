// Modified for Triune.
import { useEffect, useState } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CONVERSATION_DRAG_MIME, DockWorkspace, type DockWorkspaceProps } from "./DockWorkspace";
import {
  addDockView,
  createDockLayout,
  dockPaneForView,
  moveDockView,
  resizeDockSplit,
  selectDockView,
  type DockLayout,
  type DockPlacement,
  type DockView,
} from "./dockLayout";
import { dockStorageKey } from "./dockPersistence";
import { useDockLayout, type DockStorage } from "./useDockLayout";
import { terminalLayoutGeometry } from "@/lib/terminalSplitLayout";

const view = (id: string, kind = "editor"): DockView => ({
  id,
  kind,
  title: id,
  resource: { scope: "host-a", path: `/${id}` },
});
const scope = { accountId: "account", serverId: "server", clientId: "client" };
const conversationView = (id: string): DockView => ({
  id: `conversation:${id}`,
  kind: "conversation",
  title: id,
  resource: { conversationId: id },
});

function chatTransfer(payload: unknown, type = CONVERSATION_DRAG_MIME) {
  return { types: [type], getData: () => JSON.stringify(payload), dropEffect: "none" };
}

function memoryStorage(): DockStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("DockWorkspace resource mounts", () => {
  it("does not render unchanged retained resources for resizing, pin chrome or a new file", () => {
    const renders = vi.fn();
    const renderView: DockWorkspaceProps["renderView"] = (item, state) => {
      renders(item.id);
      return <span data-testid={`resource-${item.id}`}>{JSON.stringify({ item, state })}</span>;
    };
    const a = view("a");
    const hidden = view("hidden");
    let layout = addDockView(createDockLayout([a]), view("b"), { edge: "right" });
    const props = { renderView, retainedViews: [hidden], onLayoutChange: vi.fn() };
    const rendered = render(<DockWorkspace {...props} layout={layout} />);
    renders.mockClear();
    layout = resizeDockSplit(layout, [], 0.7);
    rendered.rerender(<DockWorkspace {...props} layout={layout} pinnedViewIds={["a"]} />);
    expect(renders).not.toHaveBeenCalled();
    expect(screen.getByRole("separator", { name: "Resize panes" })).toHaveAttribute(
      "aria-valuenow",
      "70",
    );
    layout = addDockView(layout, view("new-file"));
    rendered.rerender(<DockWorkspace {...props} layout={layout} />);
    expect(renders.mock.calls.map(([id]) => id)).toEqual(["b", "new-file"]);
    renders.mockClear();
    layout = { ...layout, views: structuredClone(layout.views) };
    rendered.rerender(
      <DockWorkspace {...props} retainedViews={structuredClone([hidden])} layout={layout} />,
    );
    expect(renders).not.toHaveBeenCalled();
    layout = {
      ...layout,
      views: layout.views.map((item) =>
        item.id === "a" ? { ...item, resource: { ...item.resource, line: 42 } } : item,
      ),
    };
    rendered.rerender(<DockWorkspace {...props} layout={layout} />);
    expect(renders.mock.calls.map(([id]) => id)).toEqual(["a"]);
    expect(screen.getByTestId("resource-a")).toHaveTextContent('"line":42');
    renders.mockClear();
    rendered.rerender(
      <DockWorkspace
        {...props}
        layout={layout}
        renderView={(item, state) => <div>Updated {renderView(item, state)}</div>}
      />,
    );
    expect(renders).toHaveBeenCalledTimes(3);
  });

  it("preserves the actual editor DOM, component state, focus and selection through moves, split resize and mobile transitions", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Editor({ id }: { id: string }) {
      const [draft, setDraft] = useState("");
      useEffect(() => {
        mounted(id);
        return () => unmounted(id);
      }, [id]);
      return (
        <input
          aria-label={`Draft ${id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      );
    }
    let layout = createDockLayout([view("a"), view("b")]);
    const renderView: DockWorkspaceProps["renderView"] = (item, state) => (
      <div data-visible={state.visible} data-resource={item.id}>
        <Editor id={item.id} />
      </div>
    );
    const props = { onLayoutChange: vi.fn(), renderView };
    const rendered = render(<DockWorkspace {...props} layout={layout} />);
    const input = screen.getByLabelText("Draft a") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "unsaved content" } });
    input.focus();
    input.setSelectionRange(2, 7);
    const checkIdentity = () => {
      expect(screen.getByLabelText("Draft a")).toBe(input);
      expect(input.value).toBe("unsaved content");
      expect(input.selectionStart).toBe(2);
      expect(input.selectionEnd).toBe(7);
      expect(mounted).toHaveBeenCalledTimes(2);
      expect(unmounted).not.toHaveBeenCalled();
    };
    layout = moveDockView(layout, "a", { paneId: "main", edge: "right" });
    rendered.rerender(<DockWorkspace {...props} layout={layout} />);
    checkIdentity();
    expect(document.activeElement).toBe(input);
    layout = resizeDockSplit(layout, [], 0.7);
    rendered.rerender(<DockWorkspace {...props} layout={layout} />);
    checkIdentity();
    layout = moveDockView(layout, "a", { paneId: "main", index: 0 });
    rendered.rerender(<DockWorkspace {...props} layout={layout} compact />);
    checkIdentity();
    layout = selectDockView(layout, "b");
    rendered.rerender(<DockWorkspace {...props} layout={layout} compact />);
    expect(input.closest("[data-dock-view]")).toHaveAttribute("hidden");
    expect(input.closest("[data-dock-view]")).toHaveAttribute("inert");
    layout = selectDockView(layout, "a");
    rendered.rerender(<DockWorkspace {...props} layout={layout} compact={false} />);
    checkIdentity();
    expect(input.closest("[data-dock-view]")).not.toHaveAttribute("inert");
  });

  it("retains inactive saved views and reports visibility/focus independently, but resets at scope boundaries", () => {
    const mounted = vi.fn();
    function Resource({ id }: { id: string }) {
      useEffect(() => {
        mounted(id);
      }, [id]);
      return <span>{id} resource</span>;
    }
    const a = view("a");
    const b = view("b");
    const renderView: DockWorkspaceProps["renderView"] = (item, state) => (
      <div
        data-testid={`visibility-${item.id}`}
        data-visible={state.visible}
        data-focused={state.focused}
      >
        <Resource id={item.id} />
      </div>
    );
    const props = { renderView, retainedViews: [a, b], onLayoutChange: vi.fn() };
    const rendered = render(
      <DockWorkspace {...props} scopeKey="account-a" layout={createDockLayout([a])} />,
    );
    const original = screen.getByText("a resource");
    rendered.rerender(
      <DockWorkspace {...props} scopeKey="account-a" layout={createDockLayout([b])} />,
    );
    expect(screen.getByTestId("visibility-a")).toHaveAttribute("data-visible", "false");
    expect(screen.getByTestId("visibility-a")).toHaveAttribute("data-focused", "false");
    rendered.rerender(
      <DockWorkspace {...props} scopeKey="account-a" layout={createDockLayout([a])} />,
    );
    expect(screen.getByText("a resource")).toBe(original);
    expect(mounted).toHaveBeenCalledTimes(2);
    rendered.rerender(
      <DockWorkspace {...props} scopeKey="account-b" layout={createDockLayout([a])} />,
    );
    expect(screen.getByText("a resource")).not.toBe(original);
    expect(mounted).toHaveBeenCalledTimes(3);
  });

  it("deactivates resources with the whole workbench and preserves their DOM and drafts on return", () => {
    const mounted = vi.fn();
    function Resource({ id }: { id: string }) {
      const [draft, setDraft] = useState("");
      useEffect(() => {
        mounted(id);
      }, [id]);
      return (
        <input
          aria-label={`Active draft ${id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      );
    }
    const a = view("a");
    const b = view("b");
    const renderView: DockWorkspaceProps["renderView"] = (item, state) => (
      <div
        data-testid={`active-${item.id}`}
        data-visible={state.visible}
        data-focused={state.focused}
      >
        <Resource id={item.id} />
      </div>
    );
    const props = {
      layout: createDockLayout([a]),
      retainedViews: [b],
      renderView,
      onLayoutChange: vi.fn(),
    };
    const { rerender } = render(<DockWorkspace {...props} />);
    const draft = screen.getByLabelText("Active draft a");
    fireEvent.change(draft, { target: { value: "unsent" } });
    expect(screen.getByTestId("active-a")).toHaveAttribute("data-visible", "true");
    rerender(<DockWorkspace {...props} active={false} />);
    for (const id of ["a"]) {
      expect(screen.getByTestId(`active-${id}`)).toHaveAttribute("data-visible", "false");
      expect(screen.getByTestId(`active-${id}`)).toHaveAttribute("data-focused", "false");
      expect(screen.getByTestId(`active-${id}`).closest("[data-dock-view]")).toHaveAttribute(
        "inert",
      );
    }
    rerender(<DockWorkspace {...props} active />);
    expect(screen.getByLabelText("Active draft a")).toBe(draft);
    expect(draft).toHaveValue("unsent");
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("active-a")).toHaveAttribute("data-focused", "true");
    expect(screen.queryByTestId("active-b")).not.toBeInTheDocument();
  });

  it("offers every pane on mobile and preserves selected tabs in unfocused panes", async () => {
    const user = userEvent.setup();
    const initial = addDockView(createDockLayout([view("a"), view("b")]), view("c"), {
      edge: "right",
    });
    function Workspace() {
      const [layout, setLayout] = useState(initial);
      return (
        <DockWorkspace
          layout={layout}
          onLayoutChange={setLayout}
          compact
          renderView={(item, state) => (
            <div data-testid={item.id} data-visible={state.visible}>
              {item.title} content
            </div>
          )}
        />
      );
    }
    render(<Workspace />);
    expect(screen.queryByRole("combobox", { name: "Open views" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getByTestId("c")).toHaveAttribute("data-visible", "true");
    await user.click(screen.getByRole("tab", { name: "b" }));
    expect(screen.getByTestId("c")).toHaveAttribute("data-visible", "false");
    expect(screen.getByTestId("b")).toHaveAttribute("data-visible", "true");
    expect(screen.getByRole("tab", { name: "b" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "c" })).toHaveAttribute("aria-selected", "false");
    await user.click(screen.getByRole("tab", { name: "c" }));
    expect(screen.getByTestId("c")).toHaveAttribute("data-visible", "true");
    expect(screen.getByRole("tab", { name: "b" })).toHaveAttribute("aria-selected", "false");
    expect(document.querySelectorAll('.dock-pane[data-focused="true"]')).toHaveLength(1);
    expect(screen.queryByRole("separator", { name: "Resize panes" })).not.toBeInTheDocument();
  });

  it("reorders, selects and resizes through keyboard controls without remounting a resource", () => {
    let current: DockLayout = addDockView(createDockLayout([view("a"), view("b")]), view("c"), {
      edge: "right",
    });
    function Workspace() {
      const [layout, setLayout] = useState(current);
      current = layout;
      return (
        <DockWorkspace
          layout={layout}
          onLayoutChange={setLayout}
          renderView={(item) => <input aria-label={`Resource ${item.id}`} />}
        />
      );
    }
    render(<Workspace />);
    const resource = screen.getByLabelText("Resource a");
    fireEvent.keyDown(screen.getByRole("tab", { name: "a" }), { key: "ArrowRight", altKey: true });
    expect(current.panes[0].viewIds).toEqual(["b", "a"]);
    expect(screen.queryByRole("button", { name: "Pane actions" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize panes" }), {
      key: "ArrowRight",
    });
    expect(current.tree).toMatchObject({ ratio: 0.55 });
    expect(screen.getByLabelText("Resource a")).toBe(resource);
    fireEvent.keyDown(screen.getByRole("tab", { name: "a" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "b" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Resource a")).toBe(resource);
  });

  it("routes a real pointer drag onto another tab and preserves the resource node", async () => {
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const tab = this.matches('[role="tab"]') ? this : this.querySelector('[role="tab"]');
        const left = tab?.textContent === "b" ? 100 : 0;
        return new DOMRect(
          left,
          0,
          this.classList.contains("dock-tab-group") || this.matches('[role="tab"]') ? 100 : 800,
          48,
        );
      });
    let current = createDockLayout([view("a"), view("b")]);
    function Workspace() {
      const [layout, setLayout] = useState(current);
      current = layout;
      return (
        <DockWorkspace
          layout={layout}
          onLayoutChange={setLayout}
          renderView={(item) => <input aria-label={`Drag ${item.id}`} />}
        />
      );
    }
    try {
      render(<Workspace />);
      const resource = screen.getByLabelText("Drag a");
      fireEvent.mouseDown(screen.getByRole("tab", { name: "a" }), {
        button: 0,
        clientX: 20,
        clientY: 20,
      });
      fireEvent.mouseMove(document, { clientX: 40, clientY: 20 });
      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "a" })).toHaveAttribute("data-dragging", "true"),
      );
      fireEvent.mouseMove(document, { clientX: 150, clientY: 20 });
      expect(document.querySelector('.dock-tab-end[data-insertion="true"]')).toBeInTheDocument();
      fireEvent.mouseUp(document, { clientX: 150, clientY: 20 });
      expect(current.panes[0].viewIds).toEqual(["b", "a"]);
      expect(screen.getByLabelText("Drag a")).toBe(resource);
      // dnd-kit suppresses document clicks for 50ms after pointer release.
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 60);
        });
      });
    } finally {
      bounds.mockRestore();
    }
  });

  it("guards close asynchronously, prevents duplicate requests, reports errors and preserves moved targets", async () => {
    let decision = deferred<boolean>();
    const guard = vi.fn(() => decision.promise);
    let current = createDockLayout([view("a"), view("b")]);
    const change = vi.fn((update: Parameters<DockWorkspaceProps["onLayoutChange"]>[0]) => {
      current = typeof update === "function" ? update(current) : update;
    });
    const props = {
      onLayoutChange: change,
      onBeforeClose: guard,
      renderView: (item: DockView) => <span>{item.id} content</span>,
    };
    const rendered = render(<DockWorkspace {...props} layout={current} />);
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    expect(guard).toHaveBeenCalledTimes(1);
    await act(async () => decision.resolve(false));
    expect(current.views).toHaveLength(2);
    decision = deferred<boolean>();
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    await act(async () => decision.reject(new Error("Save failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
    expect(current.views).toHaveLength(2);
    decision = deferred<boolean>();
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    current = moveDockView(current, "a", { paneId: "main", edge: "right" });
    rendered.rerender(<DockWorkspace {...props} layout={current} />);
    await act(async () => decision.resolve(true));
    expect(current.views.map((item) => item.id)).toEqual(["b"]);
  });

  it("does not close a replacement resource when an old guard resolves", async () => {
    const decision = deferred<boolean>();
    let current = createDockLayout([view("a")]);
    const change = (update: Parameters<DockWorkspaceProps["onLayoutChange"]>[0]) => {
      current = typeof update === "function" ? update(current) : update;
    };
    const props = {
      onLayoutChange: change,
      onBeforeClose: () => decision.promise,
      renderView: (item: DockView) => <span>{item.title}</span>,
    };
    const rendered = render(<DockWorkspace {...props} layout={current} />);
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    current = createDockLayout([{ ...view("a"), resource: { path: "/replacement" } }]);
    rendered.rerender(<DockWorkspace {...props} layout={current} />);
    await act(async () => decision.resolve(true));
    expect(current.views[0].resource.path).toBe("/replacement");
  });
});

describe("sidebar conversation drops", () => {
  it.each(["center", "left", "right", "top", "bottom", "tab"] as const)(
    "opens at the targeted %s destination without touching other panes or dirty resources",
    async (destination) => {
      const initial = addDockView(
        createDockLayout([conversationView("A"), view("dirty")]),
        view("other"),
        { edge: "right" },
      );
      let current = initial;
      const guard = vi.fn(() => false);
      const open = vi.fn((id: string, placement: DockPlacement) => {
        current = addDockView(current, conversationView(id), placement);
      });
      const props = {
        onLayoutChange: vi.fn(),
        onBeforeClose: guard,
        onOpenConversationAt: open,
        renderView: (item: DockView) => <input aria-label={`Drop resource ${item.id}`} />,
      };
      const mounted = render(
        <DockWorkspace {...props} layout={selectDockView(initial, "dirty")} />,
      );
      mounted.rerender(<DockWorkspace {...props} layout={initial} />);
      const original = screen.getByLabelText("Drop resource dirty");
      const transfer = chatTransfer({ id: "B", title: "B" });
      const root = document.querySelector(".dock-workspace")!;
      fireEvent.dragEnter(root, { dataTransfer: transfer });
      const target =
        destination === "tab"
          ? screen.getByRole("tab", { name: "dirty" })
          : document.querySelector(
              `[data-pane-id="main"] .dock-drop-zone[data-edge="${destination}"]`,
            )!;
      fireEvent.dragOver(target, { dataTransfer: transfer });
      if (destination !== "tab") expect(target).toHaveAttribute("data-over", "true");
      fireEvent.drop(target, { dataTransfer: transfer });
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      expect(open).toHaveBeenCalledWith(
        "B",
        destination === "tab"
          ? { paneId: "main", index: 1 }
          : destination === "center"
            ? { paneId: "main" }
            : { paneId: "main", edge: destination },
      );
      expect(current.panes.find((pane) => pane.id === "pane-1")).toEqual(initial.panes[1]);
      expect(current.views.find((item) => item.id === "dirty")).toBe(initial.views[1]);
      expect(screen.getByLabelText("Drop resource dirty")).toBe(original);
      expect(guard).not.toHaveBeenCalled();
      expect(document.querySelector(".dock-drop-overlay")).not.toBeInTheDocument();
    },
  );

  it("leaves file drops alone, ignores malformed chat data, and respects refused or failed opens", async () => {
    const initial = createDockLayout([view("dirty")]);
    const open = vi
      .fn<NonNullable<DockWorkspaceProps["onOpenConversationAt"]>>()
      .mockResolvedValue(false);
    const change = vi.fn();
    render(
      <DockWorkspace
        layout={initial}
        onLayoutChange={change}
        onOpenConversationAt={open}
        renderView={() => <input aria-label="Unchanged draft" />}
      />,
    );
    const root = document.querySelector(".dock-workspace")!;
    const tab = screen.getByRole("tab", { name: "dirty" });
    const files = chatTransfer({}, "Files");
    fireEvent.dragEnter(root, { dataTransfer: files });
    expect(document.querySelector(".dock-drop-overlay")).not.toBeInTheDocument();
    expect(fireEvent.drop(tab, { dataTransfer: files })).toBe(true);
    for (const payload of [null, {}, { id: "", title: "B" }, { id: "B" }, { id: 42, title: "B" }]) {
      fireEvent.drop(tab, { dataTransfer: chatTransfer(payload) });
    }
    fireEvent.drop(tab, {
      dataTransfer: { types: [CONVERSATION_DRAG_MIME], getData: () => "invalid" },
    });
    expect(open).not.toHaveBeenCalled();
    fireEvent.drop(tab, { dataTransfer: chatTransfer({ id: "B", title: "B" }) });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(change).not.toHaveBeenCalled();
    open.mockRejectedValue(new Error("Open refused"));
    fireEvent.drop(tab, { dataTransfer: chatTransfer({ id: "B", title: "B" }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("Open refused");
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Unchanged draft")).toBeInTheDocument();
  });

  it("marks only the actual outside edges, including resized nested panes and compact views", () => {
    const layout = addDockView(
      addDockView(createDockLayout([view("left")]), view("top"), { edge: "right" }),
      view("bottom"),
      { edge: "bottom" },
    );
    const props = {
      layout: resizeDockSplit(layout, [], 0.6),
      onLayoutChange: vi.fn(),
      renderView: (item: DockView) => <span>{item.id} slot</span>,
    };
    const rendered = render(<DockWorkspace {...props} />);
    const slot = (id: string) => screen.getByText(`${id} slot`).closest("[data-dock-view]")!;
    expect(slot("left")).toHaveAttribute("data-dock-bottom-edge", "true");
    expect(slot("left")).toHaveAttribute("data-dock-right-edge", "false");
    expect(slot("top")).toHaveAttribute("data-dock-bottom-edge", "false");
    expect(slot("top")).toHaveAttribute("data-dock-right-edge", "true");
    expect(slot("bottom")).toHaveAttribute("data-dock-bottom-edge", "true");
    expect(slot("bottom")).toHaveAttribute("data-dock-right-edge", "true");
    rendered.rerender(<DockWorkspace {...props} compact />);
    expect(slot("bottom")).toHaveAttribute("data-dock-bottom-edge", "true");
    expect(slot("bottom")).toHaveAttribute("data-dock-right-edge", "true");
  });
});

describe("dock tab controls", () => {
  it("allows touch swipes and activates docking only after a hold and movement", () => {
    vi.useFakeTimers();
    try {
      render(
        <DockWorkspace
          layout={createDockLayout([view("a"), view("b")])}
          onLayoutChange={vi.fn()}
          renderView={() => null}
          compact
        />,
      );
      const tab = screen.getByRole("tab", { name: "a" });
      const touch = (clientX: number) => ({ identifier: 1, target: tab, clientX, clientY: 20 });
      fireEvent.touchStart(tab, { touches: [touch(20)] });
      expect(fireEvent.touchMove(tab, { touches: [touch(60)] })).toBe(true);
      expect(tab).toHaveAttribute("data-dragging", "false");
      fireEvent.touchEnd(tab, { touches: [] });
      fireEvent.touchStart(tab, { touches: [touch(20)] });
      act(() => vi.advanceTimersByTime(300));
      expect(tab).toHaveAttribute("data-dragging", "false");
      fireEvent.touchMove(tab, { touches: [touch(30)], changedTouches: [touch(30)] });
      expect(tab).toHaveAttribute("data-dragging", "true");
      expect(tab.closest('[data-slot="context-menu-trigger"]')).toHaveAttribute("data-disabled");
      fireEvent.touchCancel(tab, { touches: [] });
      expect(tab).toHaveAttribute("data-dragging", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the tab menu at 500ms, continues into the existing drag and swallows release", () => {
    vi.useFakeTimers();
    try {
      const change = vi.fn();
      render(
        <DockWorkspace
          layout={createDockLayout([view("a"), view("b")])}
          onLayoutChange={change}
          renderView={() => null}
          compact
        />,
      );
      const tab = screen.getByRole("tab", { name: "b" });
      const touch = (clientX: number) => ({ identifier: 1, target: tab, clientX, clientY: 20 });
      fireEvent.pointerDown(tab, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 20 });
      fireEvent.touchStart(tab, { touches: [touch(20)] });
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole("menuitem", { name: "Move tab left" })).toBeVisible();
      expect(tab).toHaveAttribute("data-dragging", "false");
      fireEvent.touchMove(tab, { touches: [touch(30)], changedTouches: [touch(30)] });
      expect(tab).toHaveAttribute("data-dragging", "true");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.querySelector(".dock-drop-overlay")).toBeInTheDocument();
      fireEvent.touchCancel(tab, { touches: [] });
      fireEvent.click(tab);
      expect(change).not.toHaveBeenCalled();
      expect(tab).toHaveAttribute("data-dragging", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches once when a touch lands on the pin's former hover target", () => {
    const pin = vi.fn();
    const change = vi.fn();
    render(
      <DockWorkspace
        layout={createDockLayout([view("a"), view("b")])}
        onLayoutChange={change}
        onPinView={pin}
        renderView={() => null}
        compact
      />,
    );
    const hiddenPin = screen.getByRole("button", { name: "Pin b" });
    fireEvent.pointerDown(hiddenPin, { pointerType: "touch", pointerId: 1 });
    fireEvent.pointerUp(hiddenPin, { pointerType: "touch", pointerId: 1 });
    fireEvent.click(hiddenPin);
    expect(pin).not.toHaveBeenCalled();
    expect(change).toHaveBeenCalledTimes(1);
    const update = change.mock.calls[0][0];
    expect(update(createDockLayout([view("a"), view("b")])).panes[0].selectedViewId).toBe("b");
  });

  it.each(["before", "after", "end", "empty"] as const)(
    "moves a tab into another tab bar at %s while retaining its resource",
    async (position) => {
      let initial = addDockView(createDockLayout([view("a"), view("b")]), view("c"), {
        edge: "right",
      });
      const targetPaneId = dockPaneForView(initial, "c")!.id;
      initial = addDockView(initial, view("d"), { paneId: targetPaneId });
      if (position === "empty")
        initial = {
          ...initial,
          views: initial.views.filter((item) => item.id === "a" || item.id === "b"),
          panes: initial.panes.map((pane) =>
            pane.id === targetPaneId ? { ...pane, viewIds: [], selectedViewId: null } : pane,
          ),
        };
      let current = initial;
      function Workspace() {
        const [layout, setLayout] = useState(initial);
        current = layout;
        return (
          <DockWorkspace
            layout={layout}
            onLayoutChange={setLayout}
            renderView={(item) => <input aria-label={`Cross ${item.id}`} />}
          />
        );
      }
      const bounds = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          if (this.classList.contains("dock-tab-group") || this.matches('[role="tab"]')) {
            const title = this.querySelector('[role="tab"]')?.textContent ?? this.textContent;
            return new DOMRect(
              ({ a: 0, b: 100, c: 400, d: 500 } as Record<string, number>)[title ?? ""] ?? 0,
              0,
              100,
              48,
            );
          }
          if (this.classList.contains("dock-tab-end"))
            return this.dataset.conversationDropPane === targetPaneId
              ? new DOMRect(
                  position === "empty" ? 400 : 600,
                  0,
                  position === "empty" ? 400 : 200,
                  48,
                )
              : new DOMRect(200, 0, 200, 48);
          if (this.classList.contains("dock-drop-zone")) return new DOMRect(0, 48, 800, 500);
          return new DOMRect(0, 0, 800, 600);
        });
      try {
        render(<Workspace />);
        const resource = screen.getByLabelText("Cross a");
        fireEvent.mouseDown(screen.getByRole("tab", { name: "a" }), {
          button: 0,
          clientX: 20,
          clientY: 20,
        });
        fireEvent.mouseMove(document, { clientX: 40, clientY: 20 });
        await waitFor(() =>
          expect(screen.getByRole("tab", { name: "a" })).toHaveAttribute("data-dragging", "true"),
        );
        const x = position === "before" ? 420 : position === "after" ? 480 : 650;
        fireEvent.mouseMove(document, { clientX: x, clientY: 20 });
        const marker = document.querySelector('[data-insertion="true"]');
        expect(marker).toHaveAttribute("data-conversation-drop-pane", targetPaneId);
        expect(marker).toHaveAttribute(
          "data-conversation-drop-index",
          position === "after" ? "1" : position === "end" ? "2" : "0",
        );
        fireEvent.mouseUp(document, { clientX: x, clientY: 20 });
        expect(current.panes.find((pane) => pane.id === targetPaneId)?.viewIds).toEqual(
          position === "empty"
            ? ["a"]
            : position === "before"
              ? ["a", "c", "d"]
              : position === "after"
                ? ["c", "a", "d"]
                : ["c", "d", "a"],
        );
        expect(screen.getByLabelText("Cross a")).toBe(resource);
        expect(document.querySelector(".dock-placement-preview")).not.toBeInTheDocument();
        await act(async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 60);
          });
        });
      } finally {
        bounds.mockRestore();
      }
    },
  );

  it("shows directional fades only where tabs overflow and reveals keyboard-selected tabs", () => {
    const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
    function Workspace() {
      const [layout, setLayout] = useState(createDockLayout([view("a"), view("b")]));
      return (
        <DockWorkspace
          layout={layout}
          onLayoutChange={setLayout}
          renderView={() => null}
          openActions={[]}
          compact
        />
      );
    }
    try {
      render(<Workspace />);
      const strip = screen.getByRole("tablist");
      const header = strip.parentElement!;
      expect(strip).toHaveAttribute("data-workspace-tabs-viewport");
      expect(strip.querySelector(".dock-tab-add")).toBeInTheDocument();
      expect(header).toHaveAttribute("data-overflow-left", "false");
      expect(header).toHaveAttribute("data-overflow-right", "false");
      Object.defineProperties(strip, {
        clientWidth: { configurable: true, value: 200 },
        scrollWidth: { configurable: true, value: 400 },
        scrollLeft: { configurable: true, writable: true, value: 0 },
      });
      fireEvent.scroll(strip);
      expect(header).toHaveAttribute("data-overflow-left", "false");
      expect(header).toHaveAttribute("data-overflow-right", "true");
      strip.scrollLeft = 100;
      fireEvent.scroll(strip);
      expect(header).toHaveAttribute("data-overflow-left", "true");
      expect(header).toHaveAttribute("data-overflow-right", "true");
      strip.scrollLeft = 200;
      fireEvent.scroll(strip);
      expect(header).toHaveAttribute("data-overflow-left", "true");
      expect(header).toHaveAttribute("data-overflow-right", "false");
      Object.defineProperty(strip, "scrollWidth", { value: 200 });
      strip.scrollLeft = 0;
      fireEvent.scroll(strip);
      expect(header).toHaveAttribute("data-overflow-left", "false");
      expect(header).toHaveAttribute("data-overflow-right", "false");
      fireEvent.keyDown(screen.getByRole("tab", { name: "a" }), { key: "ArrowRight" });
      expect(screen.getByRole("tab", { name: "b" })).toHaveFocus();
      expect(reveal).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
    } finally {
      reveal.mockRestore();
    }
  });

  it("uses the shared wheel behavior only inside an overflowing dock tab strip", () => {
    render(
      <DockWorkspace
        layout={createDockLayout([view("a"), view("b")])}
        onLayoutChange={vi.fn()}
        renderView={(item) => <div data-testid={`pane-content-${item.id}`} />}
      />,
    );
    const strip = screen.getByRole("tablist");
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 400 },
    });
    expect(fireEvent.wheel(strip, { deltaY: 30 })).toBe(false);
    expect(strip.scrollLeft).toBe(30);
    expect(fireEvent.wheel(strip, { deltaX: 12, deltaY: 20 })).toBe(true);
    expect(fireEvent.wheel(screen.getByTestId("pane-content-a"), { deltaY: 30 })).toBe(true);
    expect(strip.scrollLeft).toBe(30);
    Object.defineProperty(strip, "scrollWidth", { value: 200 });
    expect(fireEvent.wheel(strip, { deltaY: 30 })).toBe(true);
    expect(strip.scrollLeft).toBe(30);
  });

  it("opens the shared context menu for the clicked tab and routes close through its guard", async () => {
    const user = userEvent.setup();
    const guard = vi.fn(async () => false);
    const pin = vi.fn();
    let current = createDockLayout([view("a"), view("b")]);
    function Workspace() {
      const [layout, setLayout] = useState(current);
      current = layout;
      return (
        <DockWorkspace
          layout={layout}
          onLayoutChange={setLayout}
          onBeforeClose={guard}
          onPinView={pin}
          renderView={(item) => <input aria-label={`Menu ${item.id}`} />}
        />
      );
    }
    render(<Workspace />);
    await user.click(screen.getByRole("tab", { name: "b" }));
    const resource = screen.getByLabelText("Menu b");
    await user.click(screen.getByRole("tab", { name: "a" }));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "b" }));
    expect(screen.getByRole("menu")).toHaveAttribute("data-slot", "context-menu-content");
    expect(screen.getByRole("menuitem", { name: "Move tab right" })).toHaveAttribute(
      "data-disabled",
    );
    await user.click(screen.getByRole("menuitem", { name: "Keep open across chats" }));
    expect(pin).toHaveBeenCalledWith("b");
    fireEvent.contextMenu(screen.getByRole("tab", { name: "b" }));
    await user.click(screen.getByRole("menuitem", { name: "Split right" }));
    expect(dockPaneForView(current, "b")?.id).not.toBe("main");
    expect(screen.getByLabelText("Menu b")).toBe(resource);
    fireEvent.keyDown(screen.getByRole("tab", { name: "b" }), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Split right" })).toHaveAttribute("data-disabled");
    await user.click(screen.getByRole("menuitem", { name: "Close view" }));
    expect(guard).toHaveBeenCalledWith(view("b"));
    expect(screen.getByLabelText("Menu b")).toBe(resource);
    expect(current.views).toHaveLength(2);
  });

  it("keeps the resize hitbox while tracking the active drag", () => {
    const layout = addDockView(createDockLayout([view("a")]), view("b"), { edge: "right" });
    render(<DockWorkspace layout={layout} onLayoutChange={vi.fn()} renderView={() => null} />);
    const divider = screen.getByRole("separator", { name: "Resize panes" });
    expect(divider).toHaveStyle({ width: "7px" });
    fireEvent.pointerDown(divider, { pointerId: 1 });
    expect(divider).toHaveAttribute("data-resizing", "true");
    fireEvent.pointerCancel(divider, { pointerId: 1 });
    expect(divider).toHaveAttribute("data-resizing", "false");
  });

  it("renders an empty pane as a real header and sidebar drop destination", async () => {
    const initial = addDockView(createDockLayout([view("a")]), view("b"), { edge: "right" });
    const emptyPaneId = dockPaneForView(initial, "b")!.id;
    const layout: DockLayout = {
      ...initial,
      views: initial.views.filter((item) => item.id !== "b"),
      panes: initial.panes.map((pane) =>
        pane.id === emptyPaneId ? { ...pane, viewIds: [], selectedViewId: null } : pane,
      ),
    };
    const open = vi.fn();
    render(
      <DockWorkspace
        layout={layout}
        onLayoutChange={vi.fn()}
        onOpenConversationAt={open}
        renderView={() => null}
      />,
    );
    const emptyHeader = screen.getByRole("tablist", { name: `Views in ${emptyPaneId}` });
    expect(emptyHeader.querySelector('[role="tab"]')).toBeNull();
    const transfer = chatTransfer({ id: "B", title: "B" });
    fireEvent.dragEnter(emptyHeader, { dataTransfer: transfer });
    const end = emptyHeader.querySelector(".dock-tab-end")!;
    fireEvent.dragOver(end, { dataTransfer: transfer });
    expect(end).toHaveAttribute("data-insertion", "true");
    expect(document.querySelector(".dock-placement-preview")).toHaveStyle({
      left: "50%",
      width: "50%",
      height: "100%",
    });
    fireEvent.drop(end, { dataTransfer: transfer });
    await waitFor(() => expect(open).toHaveBeenCalledWith("B", { paneId: emptyPaneId, index: 0 }));
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });
});

describe("useDockLayout", () => {
  it("automatically restores A plus Explorer, keeps explicitly opened B in A, and reloads each owner", async () => {
    const storage = memoryStorage();
    const initialLayout = createDockLayout([conversationView("A")]);
    const { result, unmount } = renderHook(() => useDockLayout({ scope, storage, initialLayout }));
    expect(result.current.activeConversationId).toBe("A");
    act(() => {
      result.current.addView(view("explorer", "explorer"), { edge: "right" });
      result.current.setLayout((layout) => resizeDockSplit(layout, [], 0.65));
    });
    const a = result.current.layout;
    await act(async () => {
      await result.current.navigateConversation("B");
    });
    expect(result.current.layout.views.map((item) => item.resource.conversationId)).toEqual(["B"]);
    act(() => result.current.addView(view("b-search", "search"), { edge: "bottom" }));
    const b = result.current.layout;
    await act(async () => {
      await result.current.navigateConversation("A");
    });
    expect(result.current.layout).toEqual(a);
    act(() => result.current.addView(conversationView("B"), { paneId: "main", edge: "right" }));
    expect(result.current.activeConversationId).toBe("A");
    expect(result.current.layout.views.map((item) => item.id)).toEqual([
      "conversation:A",
      "explorer",
      "conversation:B",
    ]);
    const aWithB = result.current.layout;
    unmount();
    const reloaded = renderHook(() => useDockLayout({ scope, storage, initialLayout }));
    expect(reloaded.result.current.activeConversationId).toBe("A");
    expect(reloaded.result.current.layout).toEqual(aWithB);
    await act(async () => {
      await reloaded.result.current.navigateConversation("B");
    });
    expect(reloaded.result.current.layout).toEqual(b);
    await act(async () => {
      await reloaded.result.current.navigateConversation("A");
    });
    expect(reloaded.result.current.layout).toEqual(aWithB);
  });

  it("pins from the tab before close and unpins into the current owner's layout", async () => {
    const user = userEvent.setup();
    let dock!: ReturnType<typeof useDockLayout>;
    function Workspace() {
      dock = useDockLayout({
        scope,
        storage: null,
        initialLayout: addDockView(
          createDockLayout([conversationView("A")]),
          view("Explorer", "explorer"),
          { edge: "right" },
        ),
      });
      return (
        <DockWorkspace
          layout={dock.layout}
          onLayoutChange={dock.setLayout}
          retainedViews={dock.retainedViews}
          pinnedViewIds={dock.pinnedViewIds}
          onPinView={dock.pinView}
          onUnpinView={dock.unpinView}
          renderView={(item) => <input aria-label={`Pin resource ${item.id}`} />}
        />
      );
    }
    render(<Workspace />);
    const explorer = screen.getByLabelText("Pin resource Explorer");
    const pin = screen.getByRole("button", { name: "Pin Explorer" });
    const tabGroup = pin.closest(".dock-tab-group")!;
    const typeIcon = tabGroup.querySelector(".dock-tab-type-icon svg");
    expect(typeIcon).toBeInTheDocument();
    expect(tabGroup).toHaveAttribute("data-pinned", "false");
    expect(pin.nextElementSibling).toBe(screen.getByRole("button", { name: "Close Explorer" }));
    act(() => pin.focus());
    await user.keyboard("{Enter}");
    expect(dock.pinnedViewIds).toEqual(["Explorer"]);
    expect(tabGroup).toHaveAttribute("data-pinned", "true");
    expect(tabGroup.querySelector(".dock-tab-type-icon svg")).toBe(typeIcon);
    expect(screen.getByRole("button", { name: "Unpin Explorer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Unpin Explorer" }).querySelector("svg"),
    ).toHaveAttribute("fill", "currentColor");
    await act(async () => {
      await dock.navigateConversation("B");
    });
    expect(screen.getByLabelText("Pin resource Explorer")).toBe(explorer);
    expect(explorer.closest("[data-dock-view]")).not.toHaveAttribute("hidden");
    await user.click(screen.getByRole("button", { name: "Unpin Explorer" }));
    expect(dock.pinnedViewIds).toEqual([]);
    await act(async () => {
      await dock.navigateConversation("A");
    });
    expect(screen.getByLabelText("Pin resource Explorer")).toBe(explorer);
  });

  it("persists splits, selection, focus and explicit chat saves; shared navigation does not delete them", async () => {
    const storage = memoryStorage();
    const initialLayout = createDockLayout([view("shared")]);
    const { result, unmount } = renderHook(() => useDockLayout({ scope, storage, initialLayout }));
    act(() => result.current.saveChatLayout("A"));
    act(() => result.current.addView(view("diff"), { edge: "right" }));
    act(() => result.current.setLayout((layout) => resizeDockSplit(layout, [], 0.65)));
    const a = result.current.layout;
    await act(async () => {
      expect(await result.current.navigateConversation("B")).toBe(true);
    });
    expect(result.current.layout.views.map((item) => item.id)).toEqual(["conversation:B"]);
    expect(result.current.hasChatLayout).toBe(true);
    act(() => result.current.addView(view("explorer"), { edge: "right" }));
    const beforePin = result.current.layout;
    const pinnedPaneId = dockPaneForView(beforePin, "explorer")!.id;
    const pinnedRectangle = terminalLayoutGeometry(beforePin.tree!).panes.find(
      (rect) => rect.key === pinnedPaneId,
    );
    act(() => result.current.pinView("explorer"));
    expect(result.current.layout.tree).toEqual(beforePin.tree);
    await act(async () => {
      await result.current.navigateConversation("A");
    });
    expect(result.current.layout.views.map((item) => item.id)).toEqual([
      "shared",
      "diff",
      "explorer",
    ]);
    expect(
      terminalLayoutGeometry(result.current.layout.tree!).panes.find(
        (rect) => rect.key === pinnedPaneId,
      ),
    ).toEqual(pinnedRectangle);
    expect(a.tree).toMatchObject({ ratio: 0.65 });
    act(() => result.current.focusView("explorer"));
    const restored = result.current.layout;
    unmount();
    const reloaded = renderHook(() => useDockLayout({ scope, storage, initialLayout }));
    expect(reloaded.result.current.layout).toEqual(restored);
    await act(async () => {
      expect(await reloaded.result.current.useSharedLayout()).toBe(true);
    });
    expect(reloaded.result.current.layout.views.map((item) => item.id)).toEqual([
      "shared",
      "explorer",
    ]);
    await act(async () => {
      await reloaded.result.current.navigateConversation("A");
    });
    expect(reloaded.result.current.layout.views.map((item) => item.id)).toEqual([
      "shared",
      "diff",
      "explorer",
    ]);
  });

  it("keeps actual instances mounted through A/B/A when the hook is wired to DockWorkspace", async () => {
    const mounted = vi.fn();
    let dock!: ReturnType<typeof useDockLayout>;
    function Resource({ id }: { id: string }) {
      useEffect(() => {
        mounted(id);
      }, [id]);
      return <input aria-label={`Saved ${id}`} />;
    }
    function Workspace() {
      dock = useDockLayout({
        scope,
        storage: null,
        initialLayout: createDockLayout([view("shared")]),
      });
      return (
        <DockWorkspace
          layout={dock.layout}
          onLayoutChange={dock.setLayout}
          retainedViews={dock.retainedViews}
          scopeKey={dock.scopeKey}
          onCloseView={dock.closeView}
          renderView={(item) => <Resource id={item.id} />}
        />
      );
    }
    render(<Workspace />);
    act(() => {
      dock.saveChatLayout("A");
      dock.addView(view("diff"), { edge: "right" });
    });
    const diff = screen.getByLabelText("Saved diff") as HTMLInputElement;
    fireEvent.change(diff, { target: { value: "draft" } });
    await act(async () => {
      await dock.navigateConversation("B");
    });
    expect(diff.closest("[data-dock-view]")).toHaveAttribute("hidden");
    act(() => {
      dock.addView(view("explorer"));
      dock.pinView("explorer");
    });
    const explorer = screen.getByLabelText("Saved explorer");
    await act(async () => {
      await dock.navigateConversation("A");
    });
    expect(screen.getByLabelText("Saved diff")).toBe(diff);
    expect(diff.value).toBe("draft");
    expect(screen.getByLabelText("Saved explorer")).toBe(explorer);
    expect(mounted.mock.calls.map(([id]) => id)).toEqual([
      "shared",
      "diff",
      "conversation:B",
      "explorer",
    ]);
  });

  it("does not apply a pending local close to another owner's copy of the same view", async () => {
    const decision = deferred<boolean>();
    const guard = vi.fn().mockReturnValueOnce(decision.promise).mockResolvedValue(true);
    const { result } = renderHook(() =>
      useDockLayout({
        scope,
        storage: null,
        initialLayout: createDockLayout([conversationView("A")]),
        onBeforeClose: guard,
      }),
    );
    act(() => result.current.addView(conversationView("B")));
    let close!: Promise<boolean>;
    act(() => {
      close = result.current.closeView("conversation:B");
    });
    await act(async () => {
      expect(await result.current.navigateConversation("B")).toBe(true);
    });
    await act(async () => {
      decision.resolve(true);
      expect(await close).toBe(false);
    });
    expect(result.current.layout.views.map((item) => item.id)).toEqual(["conversation:B"]);
    await act(async () => {
      await result.current.navigateConversation("A");
    });
    expect(result.current.layout.views.map((item) => item.id)).toEqual([
      "conversation:A",
      "conversation:B",
    ]);
  });

  it("isolates accounts/servers/clients and cancels pending actions after a scope change", async () => {
    const storage = memoryStorage();
    const decision = deferred<boolean>();
    const initialLayout = createDockLayout([view("a")]);
    const { result, rerender } = renderHook(
      ({ accountId, serverId, clientId }) =>
        useDockLayout({
          scope: { accountId, serverId, clientId },
          storage,
          initialLayout,
          onBeforeClose: () => decision.promise,
        }),
      { initialProps: scope },
    );
    act(() => result.current.addView(view("only-first")));
    let close!: Promise<boolean>;
    act(() => {
      close = result.current.closeView("a");
    });
    rerender({ ...scope, accountId: "other" });
    expect(result.current.retainedViews.map((item) => item.id)).toEqual(["a"]);
    await act(async () => {
      decision.resolve(true);
      expect(await close).toBe(false);
    });
    expect(result.current.layout.views).toHaveLength(1);
    act(() => result.current.addView(view("only-other")));
    rerender({ ...scope, serverId: "other-server" });
    expect(result.current.layout.views.map((item) => item.id)).toEqual(["a"]);
    rerender({ ...scope, clientId: "other-client" });
    expect(result.current.layout.views.map((item) => item.id)).toEqual(["a"]);
    rerender(scope);
    expect(result.current.layout.views.map((item) => item.id)).toEqual(["a", "only-first"]);
  });

  it("applies a guarded root change after another pane receives focus", async () => {
    const decision = deferred<boolean>();
    const { result } = renderHook(() =>
      useDockLayout({
        scope,
        storage: null,
        initialLayout: createDockLayout([view("a"), view("b")]),
        onBeforeClose: () => decision.promise,
      }),
    );
    let update!: Promise<boolean>;
    act(() => {
      update = result.current.updateView("a", { resource: { path: "/new-root" } });
      result.current.focusView("b");
    });
    await act(async () => {
      decision.resolve(true);
      expect(await update).toBe(true);
    });
    expect(result.current.layout.views.find((item) => item.id === "a")?.resource.path).toBe(
      "/new-root",
    );
    expect(result.current.layout.panes[0].selectedViewId).toBe("b");
  });

  it("guards close and replacements while navigation retains dirty resources", async () => {
    const guard = vi.fn(async () => false);
    const { result } = renderHook(() =>
      useDockLayout({
        scope,
        storage: null,
        initialLayout: createDockLayout([view("a")]),
        onBeforeClose: guard,
      }),
    );
    act(() => result.current.saveChatLayout("A"));
    act(() => result.current.addView(view("dirty"), { edge: "right" }));
    act(() => result.current.focusView("a"));
    expect(guard).not.toHaveBeenCalled();
    const dirty = result.current.retainedViews.find((item) => item.id === "dirty");
    await act(async () => {
      expect(await result.current.navigateConversation("B")).toBe(true);
    });
    expect(result.current.activeConversationId).toBe("B");
    expect(result.current.retainedViews.find((item) => item.id === "dirty")).toBe(dirty);
    await act(async () => {
      expect(await result.current.useSharedLayout()).toBe(true);
      expect(await result.current.navigateConversation("A")).toBe(true);
    });
    expect(guard).not.toHaveBeenCalled();
    expect(result.current.layout.views.find((item) => item.id === "dirty")).toBe(dirty);
    await act(async () => {
      expect(await result.current.closeView("dirty")).toBe(false);
    });
    await act(async () => {
      expect(await result.current.updateView("a", { title: "Renamed" })).toBe(true);
    });
    expect(result.current.layout.views.find((item) => item.id === "a")?.title).toBe("Renamed");
    await act(async () => {
      expect(await result.current.updateView("a", { resource: { path: "/new" } })).toBe(false);
    });
    expect(result.current.layout.views.find((item) => item.id === "a")?.resource.path).toBe("/a");
    guard.mockResolvedValue(true);
    await act(async () => {
      expect(await result.current.updateView("a", { resource: { path: "/new" } })).toBe(true);
    });
    expect(result.current.retainedViews.find((item) => item.id === "a")?.resource.path).toBe(
      "/new",
    );
    await act(async () => {
      expect(await result.current.closeView("dirty")).toBe(true);
    });
    expect(dockPaneForView(result.current.layout, "dirty")).toBeUndefined();
  });

  it("persists captured-original menu changes without discarding a dirty preview", async () => {
    const guard = vi.fn(async () => false);
    const storage = memoryStorage();
    const preview = view("file", "preview");
    const initialLayout = createDockLayout([preview]);
    const { result, unmount } = renderHook(() =>
      useDockLayout({ scope, storage, initialLayout, onBeforeClose: guard }),
    );
    act(() => result.current.saveChatLayout("A"));
    act(() => result.current.saveChatLayout("B"));
    const originalAttachment = { sessionId: "source", itemId: "message", reference: "/file" };
    await act(async () => {
      expect(
        await result.current.updateView("file", {
          resource: { ...preview.resource, originalAttachment },
        }),
      ).toBe(true);
    });
    expect(guard).not.toHaveBeenCalled();
    expect(
      result.current.retainedViews.find((entry) => entry.id === "file")?.resource
        .originalAttachment,
    ).toEqual(originalAttachment);
    unmount();
    const restored = renderHook(() =>
      useDockLayout({ scope, storage, initialLayout, onBeforeClose: guard }),
    );
    expect(restored.result.current.layout.views[0].resource.originalAttachment).toEqual(
      originalAttachment,
    );
    await act(async () => {
      expect(
        await restored.result.current.updateView("file", {
          resource: { ...preview.resource, path: "/another-file", originalAttachment },
        }),
      ).toBe(false);
    });
    expect(guard).toHaveBeenCalledOnce();
  });

  it("retains source resources and keeps immediate destination edits after navigation", async () => {
    const guard = vi.fn(async () => false);
    const { result } = renderHook(() =>
      useDockLayout({
        scope,
        storage: null,
        initialLayout: createDockLayout([view("a")]),
        onBeforeClose: guard,
      }),
    );
    act(() => {
      result.current.saveChatLayout("A");
      result.current.addView(view("dirty", "preview"));
    });
    const source = result.current.layout;
    let navigation!: Promise<boolean>;
    act(() => {
      navigation = result.current.navigateConversation("B");
      result.current.addView(view("newer"));
    });
    await act(async () => {
      expect(await navigation).toBe(true);
    });
    expect(result.current.activeConversationId).toBe("B");
    expect(result.current.layout.views.map((item) => item.id)).toEqual(["conversation:B", "newer"]);
    await act(async () => {
      await result.current.navigateConversation("A");
    });
    expect(result.current.layout).toEqual(source);
    expect(result.current.retainedViews.some((item) => item.id === "newer")).toBe(true);
    expect(guard).not.toHaveBeenCalled();
  });

  it("preserves title updates while a guarded replacement follows its resource into a retained layout", async () => {
    const storage = memoryStorage();
    const decision = deferred<boolean>();
    const guard = vi.fn(() => decision.promise);
    const { result } = renderHook(() =>
      useDockLayout({
        scope,
        storage,
        initialLayout: createDockLayout([conversationView("A"), view("dirty", "preview")]),
        onBeforeClose: guard,
      }),
    );
    await act(async () => {
      await result.current.navigateConversation("B");
      await result.current.navigateConversation("A");
    });
    expect(guard).not.toHaveBeenCalled();
    let replacement!: Promise<boolean>;
    act(() => {
      replacement = result.current.updateView("dirty", { resource: { path: "/new" } });
    });
    expect(guard).toHaveBeenCalledOnce();
    await act(async () => {
      await result.current.navigateConversation("B");
      await result.current.updateView("conversation:A", { title: "Latest A" });
      await result.current.updateView("conversation:B", { title: "Latest B" });
    });
    await act(async () => {
      decision.resolve(true);
      expect(await replacement).toBe(true);
    });
    expect(guard).toHaveBeenCalledOnce();
    expect(result.current.activeConversationId).toBe("B");
    expect(result.current.layout.views[0].title).toBe("Latest B");
    const persisted = JSON.parse(storage.getItem(dockStorageKey(scope))!);
    expect(
      persisted.chats.map((chat: { layout: DockLayout }) => chat.layout.views[0].title),
    ).toEqual(["Latest A", "Latest B"]);
    expect(result.current.retainedViews.find((item) => item.id === "dirty")?.resource.path).toBe(
      "/new",
    );
  });

  it.each([
    ["close", "resource"],
    ["replace", "resource"],
    ["close", "scope"],
    ["replace", "scope"],
  ] as const)("rejects a pending %s after its captured %s changes", async (operation, change) => {
    const decision = deferred<boolean>();
    const guard = vi.fn().mockReturnValueOnce(decision.promise).mockResolvedValue(true);
    const { result, rerender } = renderHook(
      ({ accountId }) =>
        useDockLayout({
          scope: { ...scope, accountId },
          storage: null,
          initialLayout: createDockLayout([conversationView("A"), view("dirty", "preview")]),
          onBeforeClose: guard,
        }),
      { initialProps: { accountId: scope.accountId } },
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending =
        operation === "close"
          ? result.current.closeView("dirty")
          : result.current.updateView("dirty", { resource: { path: "/pending" } });
    });
    await act(async () => {
      if (change === "resource")
        expect(await result.current.updateView("dirty", { resource: { path: "/newer" } })).toBe(
          true,
        );
      else rerender({ accountId: "other" });
    });
    const latest = result.current.layout;
    await act(async () => {
      decision.resolve(true);
      expect(await pending).toBe(false);
    });
    expect(result.current.layout).toEqual(latest);
    expect(result.current.layout.views.find((item) => item.id === "dirty")?.resource.path).toBe(
      change === "resource" ? "/newer" : "/dirty",
    );
  });

  it("restores late legacy views into A while preserving B, pins and A's saved geometry and selection", async () => {
    const storage = memoryStorage();
    const { result } = renderHook(() =>
      useDockLayout({ scope, storage, initialLayout: createDockLayout([conversationView("A")]) }),
    );
    act(() => {
      result.current.addView(view("a-tool"), { edge: "right" });
      result.current.setLayout((layout) => resizeDockSplit(layout, [], 0.65));
    });
    const originalA = result.current.layout;
    await act(async () => {
      await result.current.navigateConversation("B");
    });
    act(() => {
      result.current.addView(view("pin"));
      result.current.pinView("pin");
    });
    const originalB = result.current.layout;
    act(() =>
      result.current.restoreConversationViews("A", [
        view("legacy"),
        { ...view("a-tool"), resource: { path: "/stale" } },
      ]),
    );
    expect(result.current.activeConversationId).toBe("B");
    expect(result.current.layout).toEqual(originalB);
    const persisted = JSON.parse(storage.getItem(dockStorageKey(scope))!);
    const restoredA: DockLayout = persisted.chats.find(
      (chat: { conversationId: string }) => chat.conversationId === "A",
    ).layout;
    expect(restoredA.tree).toEqual(originalA.tree);
    expect(restoredA.focusedPaneId).toBe(originalA.focusedPaneId);
    expect(restoredA.panes.map((pane) => pane.selectedViewId)).toEqual(
      originalA.panes.map((pane) => pane.selectedViewId),
    );
    expect(restoredA.views).toEqual([...originalA.views, view("legacy")]);
    const saved = storage.getItem(dockStorageKey(scope));
    act(() => result.current.restoreConversationViews("A", [view("legacy")]));
    expect(storage.getItem(dockStorageKey(scope))).toBe(saved);
    await act(async () => {
      await result.current.navigateConversation("A");
    });
    expect(result.current.layout.views.some((item) => item.id === "legacy")).toBe(true);
    expect(result.current.pinnedViewIds).toEqual(["pin"]);
  });

  it("restores the first missing legacy view to the right and subsequent views into that pane", async () => {
    const storage = memoryStorage();
    const { result } = renderHook(() =>
      useDockLayout({ scope, storage, initialLayout: createDockLayout([conversationView("A")]) }),
    );
    await act(async () => {
      await result.current.navigateConversation("B");
    });
    const originalB = result.current.layout;
    act(() =>
      result.current.restoreConversationViews(
        "A",
        [conversationView("A"), view("legacy-one"), view("legacy-two")],
        { edge: "right" },
      ),
    );
    expect(result.current.activeConversationId).toBe("B");
    expect(result.current.layout).toEqual(originalB);
    const persisted = JSON.parse(storage.getItem(dockStorageKey(scope))!);
    const restoredA: DockLayout = persisted.chats.find(
      (chat: { conversationId: string }) => chat.conversationId === "A",
    ).layout;
    expect(restoredA.tree).toEqual({ axis: "columns", ratio: 0.5, children: ["main", "pane-1"] });
    expect(restoredA.panes[1].viewIds).toEqual(["legacy-one", "legacy-two"]);
    expect(restoredA.focusedPaneId).toBe("main");
    expect(restoredA.panes[0].selectedViewId).toBe("conversation:A");
  });

  it("restores a missing owner's snapshot without activating it", () => {
    const storage = memoryStorage();
    const { result } = renderHook(() =>
      useDockLayout({ scope, storage, initialLayout: createDockLayout([conversationView("B")]) }),
    );
    const original = result.current.layout;
    act(() => result.current.restoreConversationViews("A", [conversationView("A")]));
    expect(result.current.activeConversationId).toBe("B");
    expect(result.current.layout).toEqual(original);
    const persisted = JSON.parse(storage.getItem(dockStorageKey(scope))!);
    expect(
      persisted.chats.find((chat: { conversationId: string }) => chat.conversationId === "A").layout
        .views,
    ).toEqual([{ ...conversationView("A"), title: "Conversation" }]);
  });

  it("reports corrupt storage and quota failures without overwriting on load or losing current state", async () => {
    const setItem = vi.fn((_key: string, _value: string) => {
      throw new Error("Quota exceeded");
    });
    const storage = { getItem: () => "{invalid", setItem };
    const { result } = renderHook(() =>
      useDockLayout({ scope, storage, initialLayout: createDockLayout([view("a")]) }),
    );
    expect(result.current.error?.message).toContain("invalid");
    expect(setItem).not.toHaveBeenCalled();
    act(() => result.current.addView(view("b")));
    expect(result.current.layout.views).toHaveLength(2);
    expect(result.current.error?.message).toBe("Quota exceeded");
    expect(setItem.mock.calls[0][0]).toBe(dockStorageKey(scope));
    await waitFor(() => expect(result.current.error).not.toBeNull());
  });
});
