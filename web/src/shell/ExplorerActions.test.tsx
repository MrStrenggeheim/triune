// Modified for Triune.
import { resetExplorerSelectionsForTesting } from "@/lib/explorerSelection";
import userEvent from "@testing-library/user-event";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExplorerActionsProvider,
  ExplorerRowActions,
  ExplorerToolbar,
  useExplorerRow,
  useExplorerTree,
} from "./ExplorerActions";
import { downloadBlob, filesystemOperation } from "@/lib/explorerOperations";
import type { ExplorerEntry, FilesystemOperationResult } from "@/lib/explorerOperations";
import type * as ExplorerOperationsModule from "@/lib/explorerOperations";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "@/lib/notifications";
import { WorkbenchWorkspaceProvider, type WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  dismissExplorerTransfer,
  getExplorerTransfers,
  transferIsActive,
} from "@/lib/explorerTransfers";

vi.mock("@/lib/explorerOperations", async (original) => ({
  ...(await original<typeof ExplorerOperationsModule>()),
  filesystemOperation: vi.fn(),
  downloadBlob: vi.fn(),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

const entries = [
  { path: "a.txt", directory: false },
  { path: "b.txt", directory: false },
  { path: "folder", directory: true },
];
const controls = { entries };
const refresh = vi.fn(async () => {});
function Row({ entry }: { entry: ExplorerEntry }) {
  const row = useExplorerRow(entry.path, entry.directory);
  return (
    <div {...row.props} data-testid={`row-${entry.path}`}>
      <button type="button">{entry.path}</button>
      <ExplorerRowActions
        path={entry.path}
        directory={entry.directory}
        bytes={entry.directory ? null : 10}
        marker={<span data-file-status> M </span>}
      />
    </div>
  );
}
function Tree() {
  useExplorerTree(controls);
  return (
    <>
      {entries.map((entry) => (
        <Row key={entry.path} entry={entry} />
      ))}
    </>
  );
}
function setup({
  writable = true,
  base = "src",
  conversationId = "test",
  workspace,
}: {
  writable?: boolean;
  base?: string;
  conversationId?: string;
  workspace?: WorkbenchWorkspace;
} = {}) {
  return render(
    <TooltipProvider>
      <WorkbenchWorkspaceProvider value={workspace ?? null}>
        <ExplorerActionsProvider
          conversationId={conversationId}
          base={base}
          workspaceRoot="/work"
          hostId="host"
          writable={writable}
          onRefresh={refresh}
        >
          <div>
            <ExplorerToolbar />
            <Tree />
            <div data-testid="explorer-empty-space" />
          </div>
        </ExplorerActionsProvider>
        <Toaster />
      </WorkbenchWorkspaceProvider>
    </TooltipProvider>,
  );
}
async function rowMenu(path: string) {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${path}` }));
  await screen.findByRole("menu");
}
const operation = vi.mocked(filesystemOperation);
beforeEach(() => {
  resetExplorerSelectionsForTesting();
  vi.clearAllMocks();
  toast.dismiss();
  operation.mockReset().mockResolvedValue({});
  for (const transfer of getExplorerTransfers()) dismissExplorerTransfer(transfer.conversationId);
});
afterEach(cleanup);

describe("Explorer actions", () => {
  it.each(["a.txt", "folder", "empty"])(
    "opens the same actions by holding %s without activating its row",
    (path) => {
      vi.useFakeTimers();
      try {
        setup();
        const target =
          path === "empty"
            ? screen.getByTestId("explorer-empty-space")
            : screen.getByRole("button", { name: path });
        const click = vi.fn();
        target.addEventListener("click", click);
        const pointer = { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 30 };
        fireEvent.pointerDown(target, pointer);
        act(() => vi.advanceTimersByTime(499));
        expect(screen.queryByRole("menu")).toBeNull();
        act(() => vi.advanceTimersByTime(1));
        expect(screen.getByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
        if (path !== "a.txt")
          expect(screen.getByRole("menuitem", { name: "New file…" })).toBeInTheDocument();
        fireEvent.pointerUp(target, pointer);
        fireEvent.click(target);
        expect(click).not.toHaveBeenCalled();
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      } finally {
        cleanup();
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["a.txt", "folder"])(
    "replaces status and size with one keyboard/touch menu for %s",
    async (path) => {
      const user = userEvent.setup();
      setup();
      const row = screen.getByTestId(`row-${path}`);
      const marker = row.querySelector("[data-file-status]");
      const metadata = marker?.closest("[data-explorer-meta]");
      const actions = within(row).getByRole("button", { name: `Actions for ${path}` });
      expect(metadata).toHaveClass(
        "[[data-explorer-entry]:hover_&]:opacity-0",
        "[[data-explorer-entry]:focus-within_&]:opacity-0",
        "[@media(hover:none)]:hidden",
      );
      expect(metadata?.parentElement).toBe(actions.parentElement);
      expect(actions).toHaveClass(
        "absolute",
        "[@media(hover:none)]:static",
        "[@media(hover:none)]:opacity-100",
      );
      expect(actions.parentElement).toHaveClass("min-w-6");
      if (path === "a.txt") expect(metadata?.querySelector("[data-file-size]")).not.toBeNull();
      actions.focus();
      await user.keyboard("{Enter}");
      expect(await screen.findByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );

  it("shows only the trailing menu and preserves right-click actions and destructive trash styling", async () => {
    setup();
    const row = screen.getByTestId("row-a.txt");
    expect(within(row).queryByRole("checkbox")).toBeNull();
    expect(within(row).queryByRole("button", { name: /Download|Copy.*path/ })).toBeNull();
    const actions = within(row).getByRole("button", { name: "Actions for a.txt" });
    expect(actions.parentElement).not.toHaveClass("w-[104px]");
    expect(actions).toHaveClass("absolute", "opacity-0");
    await rowMenu("a.txt");
    expect(screen.getByRole("menuitem", { name: "Move to trash…" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
    expect(await screen.findByRole("menuitem", { name: "Move to trash…" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
  });

  it("routes mutations and events to the workspace while retaining legacy chat provenance", async () => {
    const workspace = {
      id: "actions-workspace",
      root: "/work",
      host_id: "host",
      target_kind: "host" as const,
      capabilities: [],
    };
    const onSearch = vi.fn();
    const onChange = vi.fn();
    window.addEventListener("omnigent:open-content-search", onSearch);
    window.addEventListener("omnigent:workspace-files-changed", onChange);
    try {
      setup({ workspace });
      await userEvent.click(screen.getByRole("button", { name: "More file actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Search folder contents…" }));
      expect((onSearch.mock.calls[0][0] as CustomEvent).detail).toEqual({
        conversationId: "test",
        workspaceId: workspace.id,
        location: "src",
      });
      fireEvent.click(screen.getByRole("button", { name: "New file" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "new.txt" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() =>
        expect(operation).toHaveBeenCalledWith(
          "test",
          { operation: "create_file", path: "src/new.txt" },
          undefined,
          workspace,
        ),
      );
      expect((onChange.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        conversationId: "test",
        workspaceId: workspace.id,
        moves: [],
        removed: [],
      });
    } finally {
      window.removeEventListener("omnigent:open-content-search", onSearch);
      window.removeEventListener("omnigent:workspace-files-changed", onChange);
    }
  });

  it("creates files at the browsed location and reports collisions without closing the dialog", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "new.txt" },
    });
    operation.mockRejectedValueOnce(new Error("File already exists"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("File already exists");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "next.txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(operation).toHaveBeenLastCalledWith("test", {
      operation: "create_file",
      path: "src/next.txt",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("selects multiple rows with Ctrl and trashes them through the toolbar", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "a.txt" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "b.txt" }), { ctrlKey: true });
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More file actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move selected items to trash…" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    await waitFor(() =>
      expect(operation).toHaveBeenCalledWith("test", {
        operation: "trash",
        path: "src",
        paths: ["src/a.txt", "src/b.txt"],
      }),
    );
  });

  it("keeps header navigation and folder downloads scoped to the current folder", async () => {
    const search = vi.fn();
    window.addEventListener("omnigent:open-content-search", search);
    setup();
    fireEvent.click(screen.getByRole("button", { name: "folder" }), { ctrlKey: true });
    await userEvent.click(screen.getByRole("button", { name: "More file actions" }));
    expect(screen.getByRole("menuitem", { name: "Download selection as ZIP" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Rename…" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Search folder contents…" }));
    expect((search.mock.calls[0][0] as CustomEvent).detail).toEqual({
      conversationId: "test",
      location: "src",
    });
    await userEvent.click(screen.getByRole("button", { name: "More file actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear selection" }));
    await userEvent.click(screen.getByRole("button", { name: "More file actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Download this folder as ZIP" }),
    ).toBeInTheDocument();
    window.removeEventListener("omnigent:open-content-search", search);
  });

  it("handles Shift range selection and keyboard rename", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "a.txt" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "folder" }), { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("row-b.txt"), { key: "F2" });
    expect(screen.getByRole("dialog", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("b.txt");
  });

  it("normalizes renamed paths in the event used to reconcile open tabs", async () => {
    const changed = vi.fn();
    window.addEventListener("omnigent:workspace-files-changed", changed);
    setup();
    await rowMenu("a.txt");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "renamed.txt" },
    });
    operation.mockResolvedValueOnce({
      moved: [{ source: "/work/src/a.txt", destination: "/work/src/renamed.txt" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({
      conversationId: "test",
      moves: [{ source: "src/a.txt", destination: "src/renamed.txt" }],
      removed: [],
    });
    window.removeEventListener("omnigent:workspace-files-changed", changed);
  });

  it("keeps copies in workspace-relative scope when pasting into a folder", async () => {
    setup();
    await rowMenu("a.txt");
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New file" })).not.toBeDisabled(),
    );
    await rowMenu("folder");
    fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
    await waitFor(() =>
      expect(operation).toHaveBeenCalledWith("test", {
        operation: "copy",
        entries: [{ source: "src/a.txt", destination: "src/folder/a.txt" }],
        overwrite: false,
      }),
    );
  });

  it("requires an explicit replace action before retrying a paste collision", async () => {
    setup();
    await rowMenu("a.txt");
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New file" })).not.toBeDisabled(),
    );
    operation.mockRejectedValueOnce(new Error("Destination already exists"));
    await rowMenu("folder");
    fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace existing files?" });
    expect(operation).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(operation).toHaveBeenLastCalledWith("test", {
        operation: "copy",
        entries: [{ source: "src/a.txt", destination: "src/folder/a.txt" }],
        overwrite: true,
      }),
    );
  });

  it.each([false, true])(
    "drops a dragged selection into its target folder (copy=%s)",
    async (copy) => {
      setup();
      fireEvent.click(screen.getByRole("button", { name: "a.txt" }), { ctrlKey: true });
      fireEvent.click(screen.getByRole("button", { name: "b.txt" }), { ctrlKey: true });
      const payload = new Map<string, string>();
      const transfer = {
        get types() {
          return [...payload.keys()];
        },
        setData: (type: string, value: string) => payload.set(type, value),
        getData: (type: string) => payload.get(type) ?? "",
        effectAllowed: "",
        dropEffect: "",
      };
      fireEvent.dragStart(screen.getByTestId("row-a.txt"), { dataTransfer: transfer });
      const over = new MouseEvent("dragover", { bubbles: true, cancelable: true, ctrlKey: copy });
      Object.defineProperty(over, "dataTransfer", { value: transfer });
      fireEvent(screen.getByTestId("row-folder"), over);
      expect(screen.getByTestId("file-drop-overlay")).toHaveTextContent(
        `${copy ? "Copy" : "Move"} to src/folder`,
      );
      expect(transfer.dropEffect).toBe(copy ? "copy" : "move");
      const drop = new MouseEvent("drop", { bubbles: true, cancelable: true, ctrlKey: copy });
      Object.defineProperty(drop, "dataTransfer", { value: transfer });
      fireEvent(screen.getByTestId("row-folder"), drop);
      await waitFor(() =>
        expect(operation).toHaveBeenCalledWith("test", {
          operation: copy ? "copy" : "move",
          entries: [
            { source: "src/a.txt", destination: "src/folder/a.txt" },
            { source: "src/b.txt", destination: "src/folder/b.txt" },
          ],
          overwrite: false,
        }),
      );
    },
  );

  it("disables mutations for read-only viewers and still offers folder search", async () => {
    const search = vi.fn();
    window.addEventListener("omnigent:open-content-search", search);
    setup({ writable: false });
    expect(screen.getByRole("button", { name: "New file" })).toBeDisabled();
    await rowMenu("folder");
    expect(screen.getByRole("menuitem", { name: "Rename…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Search in folder…" }));
    expect((search.mock.calls[0][0] as CustomEvent).detail).toEqual({
      conversationId: "test",
      location: "src/folder",
    });
    window.removeEventListener("omnigent:open-content-search", search);
  });

  it("lists and restores recoverable deletions", async () => {
    operation.mockResolvedValueOnce({
      items: [
        { id: "deleted", original_path: "/work/src/old.txt", trashed_at: "today", type: "file" },
      ],
    });
    setup();
    await userEvent.click(screen.getByRole("button", { name: "More file actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore deleted files…" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore deleted files" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(operation).toHaveBeenCalledWith("test", {
        operation: "restore",
        path: "src",
        ids: ["deleted"],
      }),
    );
  });

  it("downloads folder archives in chunks and cleans the staged ZIP", async () => {
    operation.mockImplementation(async (_id, body) => {
      if (body.operation === "archive_begin")
        return { archive_id: "zip", size: 4, filename: "folder.zip" };
      if (body.operation === "archive_chunk")
        return { content_base64: body.offset === 0 ? "AAE=" : "Av8=" };
      return {};
    });
    setup();
    await rowMenu("folder");
    fireEvent.click(screen.getByRole("menuitem", { name: "Download as ZIP" }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    expect(vi.mocked(downloadBlob).mock.calls[0][0].size).toBe(4);
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe("folder.zip");
    expect(operation).toHaveBeenLastCalledWith(
      "test",
      {
        operation: "archive_cancel",
        paths: ["src/folder"],
        archive_id: "zip",
      },
      undefined,
      undefined,
    );
  });

  it("uploads binary chunks with ordered offsets and only commits after completion", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 255])], "binary.dat");
    vi.spyOn(file, "slice").mockImplementation(
      (start = 0, end = 4) =>
        ({
          arrayBuffer: async () => new Uint8Array([0, 1, 2, 255]).slice(start, end).buffer,
        }) as Blob,
    );
    operation.mockImplementation(async (_id, body): Promise<FilesystemOperationResult> =>
      body.operation === "upload_begin" ? { upload_id: "upload", chunk_size: 2 } : {},
    );
    setup();
    fireEvent.change(screen.getByLabelText("Upload files", { selector: "input" }), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() =>
      expect(operation).toHaveBeenCalledWith(
        "test",
        { operation: "upload_finish", path: "src/binary.dat", upload_id: "upload" },
        expect.any(AbortSignal),
        undefined,
      ),
    );
    const chunks = operation.mock.calls
      .map((call) => call[1])
      .filter((body) => body.operation === "upload_chunk");
    expect(chunks).toEqual([
      {
        operation: "upload_chunk",
        path: "src/binary.dat",
        upload_id: "upload",
        offset: 0,
        content_base64: "AAE=",
      },
      {
        operation: "upload_chunk",
        path: "src/binary.dat",
        upload_id: "upload",
        offset: 2,
        content_base64: "Av8=",
      },
    ]);
    await screen.findByText("Upload complete");
  });

  it("cancels an in-flight upload and removes its staging file without committing", async () => {
    const file = new File(["data"], "cancel.txt");
    vi.spyOn(file, "slice").mockReturnValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    } as Blob);
    operation.mockImplementation(async (_id, body, signal) => {
      if (body.operation === "upload_begin") return { upload_id: "cancelled", chunk_size: 4 };
      if (body.operation === "upload_chunk")
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Upload cancelled", "AbortError")),
            { once: true },
          );
        });
      return {};
    });
    const view = setup();
    fireEvent.change(screen.getByLabelText("Upload files", { selector: "input" }), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() =>
      expect(operation.mock.calls.some((call) => call[1].operation === "upload_chunk")).toBe(true),
    );
    view.unmount();
    render(<Toaster />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    await waitFor(() =>
      expect(operation).toHaveBeenCalledWith(
        "test",
        {
          operation: "upload_cancel",
          path: "src/cancel.txt",
          upload_id: "cancelled",
        },
        undefined,
        undefined,
      ),
    );
    expect(operation.mock.calls.some((call) => call[1].operation === "upload_finish")).toBe(false);
    await screen.findByText("Upload cancelled. Completed files are kept.");
  });

  it("continues uploading through folder and session navigation with its original destination", async () => {
    const file = new File(["data"], "continue.txt");
    vi.spyOn(file, "slice").mockReturnValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    } as Blob);
    let release!: () => void;
    let chunkSignal: AbortSignal | undefined;
    operation.mockImplementation(async (_id, body, signal) => {
      if (body.operation === "upload_begin") return { upload_id: "continuing", chunk_size: 4 };
      if (body.operation === "upload_chunk") {
        chunkSignal = signal;
        return new Promise((resolve) => {
          release = () => resolve({});
        });
      }
      return {};
    });
    const original = setup();
    fireEvent.change(screen.getByLabelText("Upload files", { selector: "input" }), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    original.unmount();
    const sameSession = setup({ base: "elsewhere" });
    expect(chunkSignal?.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "New file" })).toBeDisabled();
    sameSession.unmount();
    setup({ base: "other", conversationId: "another-session" });
    expect(screen.getByRole("button", { name: "New file" })).not.toBeDisabled();
    await act(async () => release());
    await screen.findByText("Upload complete");
    expect(operation).toHaveBeenCalledWith(
      "test",
      { operation: "upload_finish", path: "src/continue.txt", upload_id: "continuing" },
      expect.any(AbortSignal),
      undefined,
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(getExplorerTransfers().some(transferIsActive)).toBe(false);
  });

  it("cleans up a staging id when cancellation arrives before upload creation responds", async () => {
    const file = new File(["data"], "starting.txt");
    let finishStarting!: () => void;
    operation.mockImplementation(async (_id, body) => {
      if (body.operation === "upload_begin")
        return new Promise((resolve) => {
          finishStarting = () => resolve({ upload_id: "late-id", chunk_size: 4 });
        });
      return {};
    });
    const view = setup();
    fireEvent.change(screen.getByLabelText("Upload files", { selector: "input" }), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(finishStarting).toBeTypeOf("function"));
    view.unmount();
    render(<Toaster />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    expect(screen.queryByRole("button", { name: "Cancel upload" })).toBeNull();
    expect(screen.getByText("Cancelling and cleaning up…")).toBeInTheDocument();
    await act(async () => finishStarting());
    await screen.findByText("Upload cancelled. Completed files are kept.");
    expect(operation).toHaveBeenCalledWith(
      "test",
      {
        operation: "upload_cancel",
        path: "src/starting.txt",
        upload_id: "late-id",
      },
      undefined,
      undefined,
    );
    expect(
      operation.mock.calls.some(
        (call) => call[1].operation === "upload_chunk" || call[1].operation === "upload_finish",
      ),
    ).toBe(false);
  });

  it("keeps ZIP download and cleanup alive after the Explorer unmounts", async () => {
    let release!: () => void;
    let chunkSignal: AbortSignal | undefined;
    operation.mockImplementation(async (_id, body, signal) => {
      if (body.operation === "archive_begin")
        return { archive_id: "continuing", size: 4, filename: "folder.zip" };
      if (body.operation === "archive_chunk") {
        chunkSignal = signal;
        return new Promise((resolve) => {
          release = () => resolve({ content_base64: "AAEC/w==" });
        });
      }
      return {};
    });
    const view = setup();
    await rowMenu("folder");
    fireEvent.click(screen.getByRole("menuitem", { name: "Download as ZIP" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    view.unmount();
    render(<Toaster />);
    expect(chunkSignal?.aborted).toBe(false);
    await act(async () => release());
    await screen.findByText("Download complete");
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "folder.zip");
    expect(operation).toHaveBeenLastCalledWith(
      "test",
      {
        operation: "archive_cancel",
        paths: ["src/folder"],
        archive_id: "continuing",
      },
      undefined,
      undefined,
    );
  });

  it("retains upload failures for the global status after navigation", async () => {
    const file = new File(["data"], "failed.txt");
    vi.spyOn(file, "slice").mockReturnValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    } as Blob);
    let fail!: () => void;
    operation.mockImplementation(async (_id, body) => {
      if (body.operation === "upload_begin") return { upload_id: "failed", chunk_size: 4 };
      if (body.operation === "upload_chunk")
        return new Promise((_resolve, reject) => {
          fail = () => reject(new Error("Connection lost"));
        });
      return {};
    });
    const view = setup();
    fireEvent.change(screen.getByLabelText("Upload files", { selector: "input" }), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(fail).toBeTypeOf("function"));
    view.unmount();
    render(<Toaster />);
    await act(async () => fail());
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(operation).toHaveBeenCalledWith(
      "test",
      {
        operation: "upload_cancel",
        path: "src/failed.txt",
        upload_id: "failed",
      },
      undefined,
      undefined,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide notification" }));
    expect(screen.queryByRole("complementary", { name: "Notifications" })).not.toBeInTheDocument();
  });
});

it("enables explicit touch selection from the Explorer menu and removes checkboxes when done", async () => {
  setup();
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  fireEvent.pointerDown(screen.getByRole("button", { name: "More file actions" }), { button: 0 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Select files…" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "b.txt" }));
  expect(screen.getByTestId("row-a.txt")).toHaveAttribute("aria-selected", "true");
  expect(screen.getByTestId("row-b.txt")).toHaveAttribute("aria-selected", "true");
  fireEvent.pointerDown(screen.getByRole("button", { name: "More file actions" }), { button: 0 });
  expect(await screen.findByRole("menuitem", { name: "Copy selected items" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Done selecting" }));
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.getByTestId("row-a.txt")).toHaveAttribute("aria-selected", "false");
});

it("retains the range anchor after preview remount and toggles Ctrl entries without opening folders", () => {
  const view = setup();
  fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
  view.unmount();
  setup();
  const folder = screen.getByTestId("row-folder");
  const openFolder = vi.fn();
  folder.querySelector("button")!.addEventListener("click", openFolder);
  fireEvent.click(folder.querySelector("button")!, { shiftKey: true });
  for (const path of ["a.txt", "b.txt", "folder"])
    expect(screen.getByTestId(`row-${path}`)).toHaveAttribute("aria-selected", "true");
  expect(openFolder).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "b.txt" }), { ctrlKey: true });
  expect(screen.getByTestId("row-b.txt")).toHaveAttribute("aria-selected", "false");
  expect(folder).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("button", { name: "b.txt" }), { ctrlKey: true });
  expect(screen.getByTestId("row-b.txt")).toHaveAttribute("aria-selected", "true");
  fireEvent.click(folder.querySelector("button")!, { ctrlKey: true });
  expect(folder).toHaveAttribute("aria-selected", "false");
  expect(openFolder).not.toHaveBeenCalled();
  fireEvent.click(folder.querySelector("button")!);
  expect(openFolder).toHaveBeenCalledOnce();
  expect(screen.getByTestId("row-a.txt")).toHaveAttribute("aria-selected", "false");
});

it("clears entries and the range anchor on a free-space click without clearing on menu clicks", async () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "folder" }), { shiftKey: true });
  fireEvent.click(screen.getByTestId("explorer-empty-space"));
  for (const entry of entries)
    expect(screen.getByTestId(`row-${entry.path}`)).toHaveAttribute("aria-selected", "false");
  fireEvent.click(screen.getByRole("button", { name: "b.txt" }), { shiftKey: true });
  expect(screen.getByTestId("row-a.txt")).toHaveAttribute("aria-selected", "false");
  expect(screen.getByTestId("row-b.txt")).toHaveAttribute("aria-selected", "true");
  fireEvent.pointerDown(screen.getByRole("button", { name: "More file actions" }), { button: 0 });
  await screen.findByRole("menuitem", { name: "Copy selected items" });
  expect(screen.getByTestId("row-b.txt")).toHaveAttribute("aria-selected", "true");
});
