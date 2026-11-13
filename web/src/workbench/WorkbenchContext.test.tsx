// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { memo } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchProvider, useWorkbench, useWorkbenchActions } from "./WorkbenchContext";

afterEach(cleanup);

it("keeps navigation consumers isolated, updates selection and dispatches old actions to current handlers", () => {
  const navigationRender = vi.fn();
  const selectionRender = vi.fn();
  const opened = vi.fn();
  const Navigation = memo(function Navigation() {
    navigationRender();
    const actions = useWorkbenchActions();
    return (
      <>
        <button type="button" onClick={() => actions?.openConversation("target", { beside: true })}>
          Chat
        </button>
        <button type="button" onClick={() => actions?.openView({ kind: "files" })}>
          Files
        </button>
      </>
    );
  });
  const Selection = memo(function Selection() {
    selectionRender();
    const workbench = useWorkbench();
    return (
      <output>{`${workbench?.focusedConversationId}:${workbench?.openConversationIds?.join(",")}`}</output>
    );
  });
  const view = (focused: string, version: number, ids = ["a", "b"]) => (
    <WorkbenchProvider
      value={{
        focusedConversationId: focused,
        openConversationIds: ids,
        openConversation: (...args) => opened(version, ...args),
        openView: (...args) => opened(version, ...args),
      }}
    >
      <Navigation />
      <Selection />
    </WorkbenchProvider>
  );
  const { rerender } = render(view("a", 1));
  rerender(view("a", 2));
  expect(navigationRender).toHaveBeenCalledOnce();
  expect(selectionRender).toHaveBeenCalledOnce();
  rerender(view("b", 3));
  expect(navigationRender).toHaveBeenCalledOnce();
  expect(selectionRender).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status")).toHaveTextContent("b:a,b");
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  expect(opened.mock.calls).toEqual([
    [3, "target", { beside: true }],
    [3, { kind: "files" }],
  ]);
  rerender(view("b", 4, ["a", "b", "c"]));
  expect(screen.getByRole("status")).toHaveTextContent("b:a,b,c");
  expect(navigationRender).toHaveBeenCalledOnce();
});
