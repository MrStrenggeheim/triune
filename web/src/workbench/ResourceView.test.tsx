// Modified for Triune; inherited notices remain applicable.
import { useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceView, inheritResourceViewState } from "./ResourceView";
import { getWorkspaceComparison, setWorkspaceComparison } from "@/lib/workspaceComparison";
import { getExplorerGitScope, setExplorerGitScope } from "@/lib/explorerGitScope";
import { FileViewerContext, type FileNavigationGuard } from "@/shell/FileViewerContext";
import { useWorkbenchWorkspace, type WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import { useWriteFileContent } from "@/hooks/useWriteFileContent";
import { authenticatedFetch } from "@/lib/identity";
import { panelFolderKey, readPanelFolder, setPanelFolder } from "@/lib/panelFolder";
import type { WorkspaceSelectionDialogProps } from "@/shell/WorkspaceSelectionDialog";
import type { FileViewerProps } from "@/shell/FileViewer";

const state = vi.hoisted(() => ({
  openContentSearch: undefined as ((path: string, replace?: boolean) => void) | undefined,
  prompts: 0,
  accept: undefined as (() => void) | undefined,
  guard: undefined as FileNavigationGuard | undefined,
  confirmation: undefined as boolean | void,
  confirmError: undefined as unknown,
  viewerProps: undefined as FileViewerProps | undefined,
}));
vi.mock("@/hooks/useHosts", () => ({
  useHosts: () => ({ data: [{ host_id: "host-a", name: "Host A", status: "online" }] }),
}));
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ session: null }) }));
vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
  getCurrentUserId: () => "resource-test",
}));
vi.mock("@/shell/WorkspaceSelectionDialog", () => ({
  WorkspaceSelectionDialog: ({ open, busy, hostId, onConfirm }: WorkspaceSelectionDialogProps) =>
    open && (
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          try {
            state.confirmation = await onConfirm({ hostId, path: "/new" });
          } catch (failure) {
            state.confirmError = failure;
          }
        }}
      >
        Choose new folder
      </button>
    ),
}));
vi.mock("@/shell/FilesPanel", () => ({
  FilesPanel: ({
    onFileSelect,
    sort,
    locationControls,
  }: {
    onFileSelect: (path: string) => void;
    sort: string;
    locationControls?: ReactNode;
  }) => (
    <>
      <div data-testid="files-toolbar">{locationControls}</div>
      <button type="button" onClick={() => onFileSelect("file.txt")}>
        Open {sort}
      </button>
    </>
  ),
}));
vi.mock("@/shell/ContentSearchPanel", () => ({ ContentSearchPanel: () => null }));
vi.mock("@/shell/PullRequestPanel", () => ({ PullRequestPanel: () => null }));
vi.mock("@/shell/FileViewer", () => ({
  FileViewer: (props: FileViewerProps) => {
    const { conversationId, path, recipientValid, onClose } = props;
    state.viewerProps = props;
    const context = useContext(FileViewerContext)!;
    state.openContentSearch = context.openContentSearch;
    const workspace = useWorkbenchWorkspace();
    const save = useWriteFileContent(conversationId);
    useLayoutEffect(
      () =>
        context.registerNavigationGuard?.((_path, _options, apply) => {
          state.prompts += 1;
          state.accept = apply;
        }),
      [context],
    );
    return (
      <>
        <button type="button" onClick={() => save.mutate({ path, content: "captured", workspace })}>
          Save {workspace?.id ?? "legacy"} {recipientValid ? conversationId : "no recipient"}
        </button>
        <button type="button" onClick={onClose}>
          Close file
        </button>
      </>
    );
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.prompts = 0;
  state.accept = undefined;
  state.guard = undefined;
  state.confirmation = undefined;
  state.confirmError = undefined;
  state.viewerProps = undefined;
  setPanelFolder(panelFolderKey(original.id, "explorer")!, null);
  setPanelFolder(panelFolderKey(next.id, "explorer")!, null);
  setPanelFolder(panelFolderKey(original.id, "editor")!, null);
  setPanelFolder(panelFolderKey(next.id, "editor")!, null);
});
const original: WorkbenchWorkspace = {
  id: "original",
  root: "/old",
  host_id: "host-a",
  target_kind: "host",
  capabilities: ["files"],
  permission_level: 4,
};
const next: WorkbenchWorkspace = { ...original, id: "next", root: "/new" };
function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {children}
    </QueryClientProvider>
  );
}
it.each([
  { entry: "picker", failure: "false" },
  { entry: "picker", failure: "throw" },
  { entry: "up", failure: "false" },
  { entry: "up", failure: "throw" },
])(
  "preserves captured files and browse state when $entry application returns $failure",
  async ({ entry, failure }) => {
    const open = vi.fn();
    let finish!: (value: boolean) => void;
    let reject!: (error: Error) => void;
    const changed = vi.fn(
      () =>
        new Promise<boolean>((resolve, rejectChange) => {
          finish = resolve;
          reject = rejectChange;
        }),
    );
    const target = { ...next, root: entry === "up" ? "/old" : "/new" };
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify(target)));
    setPanelFolder(panelFolderKey(original.id, "explorer")!, "nested");
    setPanelFolder(panelFolderKey(next.id, "explorer")!, "retained");
    render(
      <ResourceView
        viewId="explorer"
        kind="files"
        workspace={original}
        onOpenFile={open}
        onWorkspaceChange={changed}
      />,
      {
        wrapper,
      },
    );
    fireEvent.click(screen.getByText("Open alpha"));
    expect(open).toHaveBeenCalledWith(
      "file.txt",
      expect.objectContaining({
        workspace: original,
        workspaceId: "original",
        sourceViewId: "explorer",
      }),
    );
    if (entry === "picker") {
      fireEvent.click(screen.getByRole("button", { name: "Select workspace: Host A:/old/nested" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose new folder" }));
    } else fireEvent.click(screen.getByRole("button", { name: "Up one folder" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith({ ...target, chatSessionId: null }));
    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/workbench-workspaces",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ host_id: "host-a", root: target.root }),
      }),
    );
    expect(screen.getByRole("button", { name: /Select workspace: Host A/ })).toBeDisabled();
    expect(state.confirmation).toBeUndefined();
    expect(readPanelFolder(panelFolderKey(next.id, "explorer"))).toBe("retained");
    await act(async () => {
      if (failure === "throw") reject(new Error("Workspace apply failed"));
      else finish(false);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Select workspace: Host A/ })).toBeEnabled(),
    );
    expect(readPanelFolder(panelFolderKey(original.id, "explorer"))).toBe("nested");
    expect(readPanelFolder(panelFolderKey(next.id, "explorer"))).toBe("retained");
    if (failure === "throw") {
      expect(screen.getByRole("alert")).toHaveTextContent("Workspace apply failed");
      if (entry === "picker")
        expect(state.confirmError).toEqual(new Error("Workspace apply failed"));
    } else if (entry === "picker") expect(state.confirmation).toBe(false);
    fireEvent.click(screen.getByText("Open alpha"));
    expect(open).toHaveBeenLastCalledWith(
      "file.txt",
      expect.objectContaining({ workspace: original }),
    );
  },
);
it("guards external navigation and close while a save retains its captured target", async () => {
  let finishSave!: (response: Response) => void;
  vi.mocked(authenticatedFetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  const closed = vi.fn();
  function Harness() {
    const [workspace, setWorkspace] = useState(original);
    return (
      <>
        <button
          type="button"
          onClick={() => state.guard!("", { workspaceId: next.id }, () => setWorkspace(next))}
        >
          Navigate externally
        </button>
        <ResourceView
          viewId="editor"
          kind="preview"
          workspace={workspace}
          path="file.txt"
          onOpenFile={vi.fn()}
          onClose={closed}
          registerNavigationGuard={(guard) => {
            state.guard = guard;
            return () => {
              state.guard = undefined;
            };
          }}
        />
      </>
    );
  }
  render(<Harness />, { wrapper });
  fireEvent.click(screen.getByText("Save original no recipient"));
  await waitFor(() => expect(finishSave).toBeDefined());
  fireEvent.click(screen.getByText("Navigate externally"));
  expect(state.prompts).toBe(1);
  expect(screen.getByText("Save original no recipient")).toBeInTheDocument();
  act(() => state.accept!());
  expect(screen.getByText("Save next no recipient")).toBeInTheDocument();
  await act(async () => finishSave(new Response("{}")));
  expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  expect(authenticatedFetch).toHaveBeenCalledWith(
    "/v1/workbench-workspaces/original/resources/environments/default/filesystem/file.txt",
    expect.objectContaining({ method: "PUT" }),
  );
  fireEvent.click(screen.getByText("Close file"));
  expect(closed).not.toHaveBeenCalled();
  act(() => state.accept!());
  expect(closed).toHaveBeenCalledOnce();
});

it("passes the comment picker and captured original download without preview location controls", () => {
  const annotationControl = <button type="button">Comments: Choose chat</button>;
  const originalDownload = vi.fn();
  const { rerender } = render(
    <ResourceView
      viewId="editor"
      kind="preview"
      workspace={original}
      path="file.txt"
      annotationControl={annotationControl}
      originalDownload={originalDownload}
      onOpenFile={vi.fn()}
      onWorkspaceChange={vi.fn()}
    />,
    { wrapper },
  );
  expect(state.viewerProps).toMatchObject({ hostLabel: "Host A", recipientValid: false });
  expect(state.viewerProps?.annotationControl).toBe(annotationControl);
  expect(state.viewerProps?.originalDownload).toBe(originalDownload);
  expect(
    screen.queryByRole("button", { name: /Location|Up one folder|Select workspace:/ }),
  ).toBeNull();
  rerender(
    <ResourceView
      viewId="editor"
      kind="preview"
      workspace={original}
      path="file.txt"
      conversationId="selected-owner"
      annotationControl={annotationControl}
      onOpenFile={vi.fn()}
    />,
  );
  expect(state.viewerProps).toMatchObject({
    conversationId: "selected-owner",
    recipientValid: true,
  });
});
it("retains an unavailable target instead of selecting an online host", () => {
  const open = vi.fn();
  render(
    <ResourceView
      viewId="offline"
      kind="files"
      workspace={{ ...original, host_id: "missing", available: false }}
      onOpenFile={open}
    />,
    { wrapper },
  );
  expect(screen.getByRole("status")).toHaveTextContent("Location unavailable: missing · /old");
  fireEvent.click(screen.getByText("Open alpha"));
  expect(open.mock.calls[0][1].workspace.host_id).toBe("missing");
});

it("copies preview comparison and repository scope once without following the explorer", () => {
  const source = { workspaceId: "inherit", viewId: "explorer", view: "files" as const };
  const preview = { ...source, viewId: "preview" };
  setWorkspaceComparison(source, { source: "range", base: "v1", target: "v2" });
  setExplorerGitScope(source, { path: "repo", directories: ["repo/src"] });
  inheritResourceViewState("explorer", "preview", "inherit", "files");
  setWorkspaceComparison(source, { source: "range", base: "v2", target: "v3" });
  setExplorerGitScope(source, { path: "other", directories: ["other"] });
  expect(getWorkspaceComparison(preview)).toEqual({ source: "range", base: "v1", target: "v2" });
  expect(getExplorerGitScope(preview)).toEqual({ path: "repo", directories: ["repo/src"] });
});

it("uses only the captured shared session when no independent workspace was authorized", async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response("{}"));
  const open = vi.fn();
  const mounted = render(
    <ResourceView
      viewId="shared"
      kind="preview"
      conversationId="shared-owner"
      path="file.txt"
      onOpenFile={open}
    />,
    { wrapper },
  );
  expect(screen.queryByRole("button", { name: /Select workspace:/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Up one folder" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Save legacy shared-owner"));
  await waitFor(() =>
    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/sessions/shared-owner/resources/environments/default/filesystem/file.txt",
      expect.objectContaining({ method: "PUT" }),
    ),
  );
  mounted.unmount();
  render(<ResourceView viewId="no-target" kind="files" onOpenFile={open} />, { wrapper });
  expect(screen.getByRole("status")).toHaveTextContent("No resource target selected");
});

const capturedSearchContext = {
  openFile: vi.fn(),
  openContentSearch: vi.fn(),
  openGithubTab: vi.fn(),
  isChangedPath: () => false,
  conversationId: "captured-owner",
  workspaceRoot: "/old",
  workspaceHome: null,
};

it("forwards the enclosing view's captured content-search action", () => {
  const openContentSearch = capturedSearchContext.openContentSearch;

  render(
    <FileViewerContext.Provider value={capturedSearchContext}>
      <ResourceView
        viewId="search-source"
        kind="preview"
        workspace={original}
        path="file.txt"
        onOpenFile={vi.fn()}
      />
    </FileViewerContext.Provider>,
    { wrapper },
  );
  expect(state.openContentSearch).toBe(openContentSearch);
  act(() => state.openContentSearch!("src", true));
  expect(openContentSearch).toHaveBeenCalledWith("src", true);
});
