// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { memo, useContext, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FileViewerContext, type FileNavigationGuard } from "@/shell/FileViewerContext";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import { CapturedFileActions } from "./CapturedFileActions";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/identity", () => ({ authenticatedFetch: fetchMock }));
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

const workspace: WorkbenchWorkspace = {
  id: "workspace-a",
  root: "/project",
  home: "/home/owner",
  host_id: "host",
  target_kind: "host",
  capabilities: ["files"],
};

it("does not broadcast reconstructed workspace/actions and keeps file targets and dirty guards live", async () => {
  const rendered = vi.fn();
  const opened = vi.fn();
  const unregister = vi.fn();
  const guard: FileNavigationGuard = (_path, _options, _navigate, cancel) => cancel?.();
  const registered = vi.fn(() => unregister);
  const Consumer = memo(function Consumer() {
    rendered();
    const context = useContext(FileViewerContext)!;
    useEffect(() => context.registerNavigationGuard?.(guard), [context]);
    return (
      <>
        <output>{context.workspaceRoot}</output>
        <button type="button" onClick={() => context.openFile("file.ts", { line: 12 })}>
          File
        </button>
        <button
          type="button"
          onClick={() => context.openFile("other.ts", { workspaceId: "workspace-b" })}
        >
          Other workspace
        </button>
        <button type="button" onClick={() => context.openContentSearch?.("src", true)}>
          Search
        </button>
        <button type="button" onClick={context.openGithubTab}>
          PR
        </button>
      </>
    );
  });
  const view = (version: number, target = workspace, conversationId = "chat-a") => (
    <CapturedFileActions
      conversationId={conversationId}
      workspace={target}
      openView={(request) => opened(version, request)}
      registerGuard={registered}
      viewId="editor"
    >
      <Consumer />
    </CapturedFileActions>
  );
  const { rerender, unmount } = render(view(1));
  rerender(view(2, structuredClone(workspace)));
  expect(rendered).toHaveBeenCalledOnce();
  expect(registered).toHaveBeenCalledExactlyOnceWith("editor", guard);
  expect(unregister).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "File" }));
  expect(opened).toHaveBeenLastCalledWith(2, {
    kind: "preview",
    workspace,
    conversationId: "chat-a",
    path: "file.ts",
    fileOptions: { line: 12 },
  });
  const updated = { ...workspace, id: "updated-identity", generation: "new-generation" };
  rerender(view(3, updated));
  expect(rendered).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(opened).toHaveBeenLastCalledWith(3, {
    kind: "search",
    workspace: updated,
    conversationId: "chat-a",
    path: "src",
    replaceOpen: true,
  });
  const other = { ...workspace, id: "workspace-b" };
  fetchMock.mockResolvedValue(new Response(JSON.stringify(other), { status: 200 }));
  fireEvent.click(screen.getByRole("button", { name: "Other workspace" }));
  await waitFor(() =>
    expect(opened).toHaveBeenLastCalledWith(3, {
      kind: "preview",
      workspace: other,
      conversationId: "chat-a",
      path: "other.ts",
      fileOptions: { workspaceId: "workspace-b" },
    }),
  );
  expect(fetchMock).toHaveBeenCalledWith("/v1/workbench-workspaces/workspace-b");
  rerender(view(4, { ...workspace, root: "/new-root" }, "chat-b"));
  expect(screen.getByRole("status")).toHaveTextContent("/new-root");
  expect(unregister).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "PR" }));
  expect(opened).toHaveBeenLastCalledWith(4, {
    kind: "pr",
    workspace: { ...workspace, root: "/new-root" },
    conversationId: "chat-b",
  });
  act(() => unmount());
  expect(unregister).toHaveBeenCalledTimes(2);
});
