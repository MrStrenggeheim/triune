// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getSessionDraft, setSessionDraft } from "@/lib/sessionDrafts";
import { useScrollRestore } from "@/shell/useScrollRestore";
import { DockWorkspace, type DockViewVisibility } from "./DockWorkspace";
import { createDockLayout, type DockView } from "./dockLayout";
import { useDockLayout, type DockStorage } from "./useDockLayout";
import { HIDDEN_VIEW_GRACE_MS } from "./viewLifetime";

const scope = { accountId: "retirement", serverId: "server", clientId: "client" };
const chat = (id: string): DockView => ({
  id,
  kind: "conversation",
  title: id,
  resource: { conversationId: id },
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps fifty saved layouts and pins while mounting visible and two recent hidden groups", async () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  const storage: DockStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  let dock!: ReturnType<typeof useDockLayout>;
  function Workspace() {
    dock = useDockLayout({ scope, storage, initialLayout: createDockLayout([chat("shared")]) });
    return (
      <DockWorkspace
        layout={dock.layout}
        layoutKey={dock.activeConversationId ?? "shared"}
        retainedViews={dock.retainedViews}
        onLayoutChange={dock.setLayout}
        pinnedViewIds={dock.pinnedViewIds}
        renderView={(view) => <span>{view.id} body</span>}
      />
    );
  }
  const mounted = render(<Workspace />);
  for (let index = 0; index < 50; index++) {
    // eslint-disable-next-line no-await-in-loop -- Verify each successive layout's resident count.
    await act(async () => {
      await dock.navigateConversation(`chat-${index}`);
    });
    expect(document.querySelectorAll("[data-dock-view]").length).toBeLessThanOrEqual(3);
  }
  expect(dock.retainedViews.filter((view) => view.kind === "conversation")).toHaveLength(51);
  const metadata = [...values.values()];
  act(() => vi.advanceTimersByTime(HIDDEN_VIEW_GRACE_MS));
  expect(document.querySelectorAll("[data-dock-view]")).toHaveLength(1);
  expect([...values.values()]).toEqual(metadata);
  await act(async () => {
    await dock.navigateConversation("chat-0");
  });
  expect(screen.getByText("conversation:chat-0 body")).toBeInTheDocument();
  act(() => dock.pinView("conversation:chat-0"));
  const pinned = dock.pinnedViewIds;
  act(() => dock.addView(chat("over-pin"), { paneId: dock.layout.focusedPaneId! }));
  act(() => vi.advanceTimersByTime(HIDDEN_VIEW_GRACE_MS));
  expect(dock.pinnedViewIds).toEqual(pinned);
  expect(screen.queryByText("conversation:chat-0 body")).not.toBeInTheDocument();
  mounted.unmount();
  render(<Workspace />);
  expect(dock.pinnedViewIds).toEqual(pinned);
  expect(dock.retainedViews.some((view) => view.id === "conversation:chat-49")).toBe(true);
});

it("retains dirty buffers, undo and selection until the model owner permits suspension", () => {
  vi.useFakeTimers();
  const editor: DockView = {
    id: "dirty",
    kind: "preview",
    title: "Dirty",
    resource: { path: "file.ts" },
  };
  const inventory = [editor, chat("other")];
  let canSuspend = false;
  const guard = vi.fn();
  function Editor() {
    const [value, setValue] = useState("original");
    const undo = useRef<string[]>([]);
    return (
      <>
        <input
          aria-label="Buffer"
          value={value}
          onChange={(event) => {
            undo.current.push(value);
            setValue(event.target.value);
          }}
        />
        <button type="button" onClick={() => setValue(undo.current.pop()!)}>
          Undo
        </button>
      </>
    );
  }
  const props = {
    retainedViews: inventory,
    onLayoutChange: vi.fn(),
    onBeforeClose: guard,
    canSuspendView: (view: DockView) => view.kind !== "preview" || canSuspend,
    renderView: (view: DockView) => (view.id === "dirty" ? <Editor /> : <span>other body</span>),
  };
  const mounted = render(<DockWorkspace {...props} layout={createDockLayout([editor])} />);
  const input = screen.getByLabelText("Buffer") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "unsaved content" } });
  input.setSelectionRange(2, 7);
  mounted.rerender(<DockWorkspace {...props} layout={createDockLayout([inventory[1]!])} />);
  act(() => vi.advanceTimersByTime(HIDDEN_VIEW_GRACE_MS * 2));
  expect(screen.getByLabelText("Buffer")).toBe(input);
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(7);
  expect(input.value).toBe("unsaved content");
  expect(guard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Undo"));
  expect(input.value).toBe("original");
  canSuspend = true;
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByLabelText("Buffer")).not.toBeInTheDocument();
  expect(guard).not.toHaveBeenCalled();
});

it("restores a parked conversation from the existing draft and scroll stores", () => {
  vi.useFakeTimers();
  const inventory = [chat("parked"), chat("next")];
  function Conversation({ view, state }: { view: DockView; state: DockViewVisibility }) {
    const [draft, setDraft] = useState(() => getSessionDraft(view.id)?.text ?? "");
    const ref = useRef<HTMLDivElement>(null);
    const onScroll = useScrollRestore(ref, `retirement:${view.id}`, true, true, state.visible);
    return (
      <div ref={ref} data-testid={`scroll-${view.id}`} onScroll={onScroll}>
        <input
          aria-label={`Draft ${view.id}`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSessionDraft(view.id, { text: event.target.value, files: [] });
          }}
        />
      </div>
    );
  }
  const props = {
    retainedViews: inventory,
    onLayoutChange: vi.fn(),
    renderView: (view: DockView, state: DockViewVisibility) => (
      <Conversation view={view} state={state} />
    ),
  };
  const mounted = render(<DockWorkspace {...props} layout={createDockLayout([inventory[0]!])} />);
  const original = screen.getByLabelText("Draft parked");
  fireEvent.change(original, { target: { value: "unsent with attachment" } });
  const file = new File(["attached"], "draft.txt");
  setSessionDraft("parked", { text: "unsent with attachment", files: [file] });
  const scroller = screen.getByTestId("scroll-parked");
  scroller.scrollTop = 640;
  fireEvent.scroll(scroller);
  mounted.rerender(<DockWorkspace {...props} layout={createDockLayout([inventory[1]!])} />);
  act(() => vi.advanceTimersByTime(HIDDEN_VIEW_GRACE_MS));
  expect(screen.queryByLabelText("Draft parked")).not.toBeInTheDocument();
  mounted.rerender(<DockWorkspace {...props} layout={createDockLayout([inventory[0]!])} />);
  expect(screen.getByLabelText("Draft parked")).not.toBe(original);
  expect(screen.getByLabelText("Draft parked")).toHaveValue("unsent with attachment");
  expect(getSessionDraft("parked")?.files).toEqual([file]);
  expect(screen.getByTestId("scroll-parked").scrollTop).toBe(640);
});
