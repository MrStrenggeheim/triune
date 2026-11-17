import { FileContentReaderContext, type FileContentReader } from "./FileContentReader";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import type * as TipTapReact from "@tiptap/react";
import type * as WorkspaceChangedFiles from "@/hooks/useWorkspaceChangedFiles";
import type * as FileContent from "@/hooks/useFileContent";
import type * as Identity from "@/lib/identity";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchWorkspaceProvider, type WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import { MarkdownRichTextViewer } from "./MarkdownRichTextViewer";
import { followLinkWithPopupFallback } from "@/lib/openLinkInApp";
import { fetchFileContent } from "@/hooks/useFileContent";

const state = vi.hoisted(() => ({
  expireBeforeCommit: false,
  canEdit: true,
  editors: [] as Editor[],
  available: false,
  chat: { conversationId: "chat-a", sessionStatus: "idle" },
  fetch: vi.fn(),
}));
vi.mock("@tiptap/react", async (importOriginal) => {
  const real = await importOriginal<typeof TipTapReact>();
  return {
    ...real,
    useEditor: (...args: Parameters<typeof real.useEditor>) => {
      const editor = real.useEditor(...args);
      if (editor && !state.editors.includes(editor)) {
        state.editors.push(editor);
        // React can yield between rendering a large document and committing effects.
        if (state.expireBeforeCommit) vi.advanceTimersByTime(2);
      }
      return editor;
    },
  };
});
vi.mock("@/hooks/usePermissions", () => ({ useCanEdit: () => state.canEdit }));
vi.mock("@/hooks/useWorkspaceChangedFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceChangedFiles>()),
  useSessionActive: () => false,
  useWorkspaceServeable: () => state.available,
}));
vi.mock("@/hooks/useFileContent", async (importOriginal) => ({
  ...(await importOriginal<typeof FileContent>()),
  fetchFileContent: vi.fn(),
}));
vi.mock("@/store/chatStore", () => ({
  useChatStore: (select: (value: typeof state.chat) => unknown) => select(state.chat),
}));
vi.mock("@/lib/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof Identity>()),
  authenticatedFetch: state.fetch,
}));
vi.mock("@/lib/openLinkInApp", () => ({ followLinkWithPopupFallback: vi.fn() }));
vi.mock("./MarkdownEditorToolbar", () => ({
  ToolbarPlugin: ({ onSave }: { onSave: () => void }) => (
    <button type="button" onClick={onSave}>
      Save draft
    </button>
  ),
}));

vi.mock("./MarkdownCommentPlugin", () => ({ MarkdownCommentPlugin: () => null }));
vi.mock("./MarkdownSearchBar", () => ({ MarkdownSearchBar: () => null }));
vi.mock("./MarkdownLinkBubble", () => ({ MarkdownLinkBubble: () => null }));

const workspaceA: WorkbenchWorkspace = {
  id: "workspace-a",
  root: "/a",
  host_id: "host-a",
  target_kind: "host",
  capabilities: ["files"],
};
const workspaceB: WorkbenchWorkspace = { ...workspaceA, id: "workspace-b", root: "/b" };
const content = "Initial paragraph.\n\n[External](https://example.test)\n";
const clients: QueryClient[] = [];
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function makeView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const onDirtyChange = vi.fn();
  const element = (chat: string, workspace: WorkbenchWorkspace | null, text = content) => (
    <QueryClientProvider client={client}>
      <WorkbenchWorkspaceProvider value={workspace}>
        <MarkdownRichTextViewer
          content={text}
          conversationId={chat}
          path="notes.md"
          isSettled
          comments={[]}
          activeSelection={null}
          onSetActiveSelection={() => {}}
          onDirtyChange={onDirtyChange}
        />
      </WorkbenchWorkspaceProvider>
    </QueryClientProvider>
  );
  return { element, onDirtyChange };
}

async function liveEditor() {
  await waitFor(() => expect(state.editors.some((editor) => !editor.isDestroyed)).toBe(true));
  // TipTap's onCreate establishes the baseline on the next task.
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  return state.editors.filter((editor) => !editor.isDestroyed).at(-1)!;
}

beforeEach(() => {
  state.expireBeforeCommit = false;
  state.canEdit = true;
  state.editors = [];
  state.available = false;
  state.chat = { conversationId: "chat-a", sessionStatus: "idle" };
  state.fetch.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.mocked(fetchFileContent)
    .mockReset()
    .mockResolvedValue({ content, encoding: "utf-8" } as Awaited<
      ReturnType<typeof fetchFileContent>
    >);
  vi.mocked(followLinkWithPopupFallback).mockClear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", window.clearTimeout);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  URL.createObjectURL = vi.fn(() => "blob:image");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("Markdown workspace editor identity", () => {
  it.each([true, false])(
    "mounts past TipTap's destruction timer with edit permission %s",
    async (canEdit) => {
      state.canEdit = canEdit;
      vi.useFakeTimers();
      state.expireBeforeCommit = true;
      try {
        const { element } = makeView();
        const view = render(element("chat-a", workspaceA));
        await act(async () => {
          vi.advanceTimersByTime(5);
        });
        const editor = state.editors.find((candidate) => !candidate.isDestroyed);
        expect(editor).toBeDefined();
        expect(view.container.querySelector(".tiptap")).toBe(editor!.view.dom);
        expect(editor!.getText()).toContain("Initial paragraph.");
        expect(editor!.isEditable).toBe(canEdit);
        expect(editor!.isFocused).toBe(false);
      } finally {
        cleanup();
        vi.useRealTimers();
      }
    },
  );
  it("retains the actual TipTap draft, selection and dirty state across a chat change", async () => {
    const { element, onDirtyChange } = makeView();
    const view = render(element("chat-a", workspaceA));
    const editor = await liveEditor();
    act(() => {
      editor.view.focus();
      editor.commands.insertContentAt(1, "Unsaved draft ");
      editor.commands.setTextSelection({ from: 2, to: 7 });
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const draft = editor.getMarkdown();
    view.rerender(element("chat-b", workspaceA));
    expect(await liveEditor()).toBe(editor);
    expect(editor.getMarkdown()).toBe(draft);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(7);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(state.fetch).not.toHaveBeenCalled();
    fireEvent.click(editor.view.dom.querySelector("a")!, { metaKey: true });
    expect(followLinkWithPopupFallback).toHaveBeenCalledWith(
      expect.anything(),
      "https://example.test",
      "chat-b",
    );
  });

  it("starts a fresh editor when the caller commits a workspace change after handling dirty state", async () => {
    const { element, onDirtyChange } = makeView();
    const view = render(element("chat-a", workspaceA));
    const first = await liveEditor();
    act(() => {
      first.view.focus();
      first.commands.insertContentAt(1, "draft ");
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    // The navigation owner handles this dirty signal before committing a new provider value.
    view.rerender(element("chat-b", workspaceB, "Different workspace document."));
    const second = await liveEditor();
    expect(second).not.toBe(first);
    await waitFor(() => expect(first.isDestroyed).toBe(true));
    expect(second.getText()).toBe("Different workspace document.");
    expect(second.getText()).not.toContain("draft ");
  });

  it("keeps image extension reads on the source workspace while links follow the current chat", async () => {
    const { element } = makeView();
    const view = render(element("chat-a", workspaceA));
    const editor = await liveEditor();
    view.rerender(element("chat-b", workspaceA));
    act(() => {
      editor.commands.insertContent({
        type: "image",
        attrs: { src: "diagram.png", alt: "diagram" },
      });
    });
    await waitFor(() =>
      expect(fetchFileContent).toHaveBeenCalledWith("chat-a", "diagram.png", workspaceA.id),
    );
  });

  it("keeps a save paused in its conflict GET on the original workspace after a resource switch", async () => {
    state.available = true;
    state.chat.sessionStatus = "running";
    let finishRead!: (value: Awaited<ReturnType<typeof fetchFileContent>>) => void;
    vi.mocked(fetchFileContent).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const { element } = makeView();
    const view = render(element("chat-a", workspaceA));
    const editor = await liveEditor();
    act(() => {
      editor.view.focus();
      editor.commands.insertContentAt(1, "saved draft ");
    });
    fireEvent.click(screen.getByText("Save draft"));
    await waitFor(() =>
      expect(fetchFileContent).toHaveBeenCalledWith("chat-a", "notes.md", workspaceA.id),
    );
    view.rerender(element("chat-b", workspaceB, "Workspace B document."));
    const next = await liveEditor();
    await act(async () =>
      finishRead({ content, encoding: "utf-8" } as Awaited<ReturnType<typeof fetchFileContent>>),
    );
    await waitFor(() => expect(state.fetch).toHaveBeenCalledOnce());
    expect(state.fetch.mock.calls[0][0]).toBe(
      "/v1/workbench-workspaces/workspace-a/resources/environments/default/filesystem/notes.md",
    );
    expect(JSON.parse(state.fetch.mock.calls[0][1].body).content).toContain("saved draft ");
    expect(next.getText()).toBe("Workspace B document.");
  });
});

const exportedContent = { current: null as FileContentReader | null };
function registerExportedContent(reader: FileContentReader) {
  exportedContent.current = reader;
  return () => {
    exportedContent.current = null;
  };
}

it("exports current Markdown source including unsaved edits without changing editor selection", async () => {
  const { element, onDirtyChange } = makeView();
  render(
    <FileContentReaderContext.Provider value={registerExportedContent}>
      {element("chat-a", workspaceA)}
    </FileContentReaderContext.Provider>,
  );
  const editor = await liveEditor();
  act(() => {
    editor.view.focus();
    editor.commands.insertContentAt(1, "**Unsaved** ");
    editor.commands.setTextSelection({ from: 2, to: 7 });
  });
  const expected = editor.getMarkdown();
  expect(exportedContent.current).not.toBeNull();
  expect(exportedContent.current?.()).toBe(expected);
  expect(expected).toContain("Unsaved");
  expect(editor.state.selection.from).toBe(2);
  expect(editor.state.selection.to).toBe(7);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  expect(state.fetch).not.toHaveBeenCalled();
});
