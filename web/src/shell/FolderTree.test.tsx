// Modified for Triune.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { copyTextMock } = vi.hoisted(() => ({ copyTextMock: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/clipboard", () => ({ copyText: copyTextMock }));

// Drive lazy-directory listings from a fixture so the tree's central
// `useWorkspaceDirectories` controller resolves nested lazy dirs without a
// network. `lazyChildren` maps a dir path to the entries the "runner" would
// return; the hook returns a Map only for the paths the tree currently asks
// for, so descending into a deeper level requires the shallower level's data
// to already be present — exactly the incremental-widening path.
const { lazyChildren, lazyErrors } = vi.hoisted(() => ({
  lazyChildren: new Map<string, unknown[]>(),
  lazyErrors: new Set<string>(),
}));
vi.mock("@/hooks/useWorkspaceChangedFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceChangedFilesModule>()),
  useWorkspaceDirectories: (_c: string | undefined, dirPaths: string[]) => {
    const map = new Map();
    for (const p of dirPaths) {
      const errored = lazyErrors.has(p);
      map.set(p, {
        data: lazyChildren.get(p),
        isLoading: !errored && !lazyChildren.has(p),
        isError: errored,
      });
    }
    return map;
  },
}));
import {
  RunnerOfflineError,
  type WorkspaceChangedFile,
  type WorkspaceFile,
} from "@/hooks/useWorkspaceChangedFiles";
import type * as WorkspaceChangedFilesModule from "@/hooks/useWorkspaceChangedFiles";
import { ROW_STATUS_SLOT_CLASS } from "./fileStatusUtils";
import { FolderTree } from "./FolderTree";
import { FileViewerContext } from "./FileViewerContext";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => copyTextMock.mockClear());

/** Render FolderTree (the "All" files tab) with defaults, overriding per test.
 *  Wrapped in a QueryClientProvider because rendered rows call
 *  `useWorkspaceDirectory` (a TanStack query) for lazy subdirectory loading. */
function renderTree(
  props: Partial<Parameters<typeof FolderTree>[0]> = {},
  activeFilePath?: string,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const viewerContext =
    activeFilePath === undefined
      ? null
      : {
          activeFilePath,
          workspaceRoot: "/work",
          workspaceHome: null,
          conversationId: "conv_abc",
          openFile: vi.fn(),
          openGithubTab: vi.fn(),
          isChangedPath: () => false,
        };
  return render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line react/jsx-no-constructed-context-values -- Each fixture mounts once with a fixed context. */}
      <FileViewerContext.Provider value={viewerContext}>
        <FolderTree
          files={undefined}
          isLoading={false}
          isError={false}
          error={null}
          onFileSelect={vi.fn()}
          conversationId="conv_abc"
          showHidden={false}
          changedFiles={undefined}
          sort="alpha"
          {...props}
        />
      </FileViewerContext.Provider>
    </QueryClientProvider>,
  );
}

function file(path: string, bytes = 10, modifiedAt: number | null = null): WorkspaceFile {
  return {
    bytes,
    modified_at: modifiedAt,
    name: path.split("/").at(-1) ?? path,
    path,
    type: "file",
  };
}

function dir(path: string, modifiedAt: number | null = null): WorkspaceFile {
  return {
    bytes: null,
    modified_at: modifiedAt,
    name: path.split("/").at(-1) ?? path,
    path,
    type: "directory",
  };
}

function change(
  path: string,
  status: WorkspaceChangedFile["status"] = "modified",
): WorkspaceChangedFile {
  return { ...file(path), status, lines_added: null, lines_removed: null };
}

describe("FolderTree runner-offline state", () => {
  it("shows the reconnect hint when the runner went offline (session failed)", () => {
    // With runnerWentOffline the "All" tab shows the same reconnect hint as
    // the Changed tab, not the generic "Failed to load".
    renderTree({ isError: true, error: new RunnerOfflineError(), runnerWentOffline: true });

    expect(screen.getByText(/agent is asleep/i)).toBeInTheDocument();
    expect(screen.getByText(/send a message in the chat to reconnect/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument();
  });

  it("shows the empty state (not the asleep hint) for a new session that hasn't started", () => {
    // A new session 503s while connecting but never went "failed" — show
    // the normal empty state, not the asleep alarm.
    renderTree({ isError: true, error: new RunnerOfflineError(), runnerWentOffline: false });

    expect(screen.getByText(/no files in workspace/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent is asleep/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument();
  });

  it("still shows the raw error for a non-runner-offline failure", () => {
    renderTree({ isError: true, error: new Error("500 Internal Server Error") });

    expect(screen.getByText(/failed to load: 500 internal server error/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent is asleep/i)).not.toBeInTheDocument();
  });
});

describe("FolderTree active file", () => {
  it.each([false, true])(
    "marks the canonical active path in tree and filename results (search=%s)",
    (search) => {
      renderTree(
        {
          files: [file("index.ts"), file("other.ts")],
          browseLocation: "src",
          workspaceRoot: "/work",
          ...(search ? { searchQuery: "index", searchResults: [file("index.ts")] } : {}),
        },
        "/work/src/index.ts",
      );
      const active = screen
        .getByText("index.ts")
        .closest("li")
        ?.querySelector("[aria-current=true]");
      expect(active).toHaveClass("bg-accent");
      expect(screen.queryByText("other.ts")?.closest("[aria-current=true]")).toBeFalsy();
    },
  );
  it("does not mark a same-named file in another browsed folder", () => {
    renderTree(
      { files: [file("index.ts")], browseLocation: "src-other", workspaceRoot: "/work" },
      "/work/src/index.ts",
    );
    expect(
      screen.getByText("index.ts").closest("li")?.querySelector("[aria-current=true]"),
    ).toBeNull();
  });
});

describe("FolderTree sorting", () => {
  it("groups directories ahead of files, then sorts files by name", () => {
    renderTree({
      files: [file("zzz.txt"), dir("mmm"), file("aaa.txt")],
      sort: "alpha",
    });
    const order = screen.getAllByText(/^(aaa\.txt|mmm\/|zzz\.txt)$/).map((el) => el.textContent);
    // Folder first (even though "mmm" sorts after "aaa"), then files by name.
    expect(order).toEqual(["mmm/", "aaa.txt", "zzz.txt"]);
  });

  it("sorts directories among themselves by last edited, still ahead of files", () => {
    renderTree({
      files: [dir("olddir", 100), file("recent.txt", 10, 200), dir("newdir", 300)],
      sort: "recent",
    });
    const order = screen
      .getAllByText(/^(olddir\/|newdir\/|recent\.txt)$/)
      .map((el) => el.textContent);
    // Directories first (newest among themselves), so the file trails even
    // though its mtime is newer than olddir's.
    expect(order).toEqual(["newdir/", "olddir/", "recent.txt"]);
  });

  it("sorts files by size (largest first), with directories grouped first", () => {
    renderTree({
      files: [file("small.txt", 5), file("big.txt", 500), dir("zdir"), file("mid.txt", 50)],
      sort: "size",
    });
    const order = screen
      .getAllByText(/^(zdir\/|big\.txt|mid\.txt|small\.txt)$/)
      .map((el) => el.textContent);
    expect(order).toEqual(["zdir/", "big.txt", "mid.txt", "small.txt"]);
  });

  it("sorts files by extension when sort is 'type'", () => {
    renderTree({
      files: [file("b.txt"), file("a.md"), file("c.js")],
      sort: "type",
    });
    const order = screen.getAllByText(/^(a\.md|b\.txt|c\.js)$/).map((el) => el.textContent);
    // Extensions sort ascending: js < md < txt.
    expect(order).toEqual(["c.js", "a.md", "b.txt"]);
  });
});

describe("FolderTree file size / download alignment", () => {
  it("keeps size visible without a reserved hover-action overlay", () => {
    renderTree({ files: [file("README.md", 2048)] });
    const size = screen.getByText("2.0 KB");
    expect(size).not.toHaveClass("group-hover:invisible");
    expect(size.closest("[data-explorer-action]")).not.toHaveClass("w-[104px]");
    expect(screen.queryByRole("button", { name: /download readme/i })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("uses the shared status slot inside each row's replaceable metadata", () => {
    renderTree({
      files: [dir("src"), file("app.ts")],
      changedFiles: [
        {
          path: "src/app.ts",
          name: "app.ts",
          status: "modified",
          bytes: 1,
          modified_at: null,
          lines_added: null,
          lines_removed: null,
        },
        {
          path: "app.ts",
          name: "app.ts",
          status: "created",
          bytes: 1,
          modified_at: null,
          lines_added: null,
          lines_removed: null,
        },
      ],
    });

    const dotSlot = screen.getByText("●").parentElement;
    const letterSlot = screen.getByText("A").parentElement;
    for (const slot of [dotSlot, letterSlot]) {
      expect(slot).toHaveClass(ROW_STATUS_SLOT_CLASS);
      expect(slot).toHaveClass("justify-center");
      expect(slot?.closest("[data-explorer-meta]")).not.toBeNull();
      expect(slot?.closest("button")).toBeNull();
    }
  });
});

describe("FolderTree folder comparison evidence", () => {
  it.each([false, true])(
    "shows mixed descendant counts in tree and filename results (search=%s)",
    async (search) => {
      renderTree({
        conversationId: `folder-counts-${search}`,
        files: [dir("src")],
        changedFiles: [
          change("src/new.ts", "created"),
          change("src/deep/edited.ts"),
          change("src/gone.ts", "deleted"),
          change("elsewhere/no.ts"),
        ],
        includeMissingChanges: false,
        ...(search ? { searchQuery: "src", searchResults: [dir("src")] } : {}),
      });
      const label = screen.getByText("src/");
      const button = screen.getByRole("button", { name: "src/" });
      expect(label.closest("span")).toHaveClass("text-amber-500");
      expect(button).toHaveAttribute(
        "aria-description",
        "src\nDescendants: 1 modified, 1 added, 1 deleted",
      );
      expect(button).not.toHaveAttribute("title");
      expect(screen.queryByText("A")).toBeNull();
      fireEvent.focus(button);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Descendants: 1 modified, 1 added, 1 deleted",
      );
      fireEvent.keyDown(button, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    },
  );

  it("never labels an existing Git folder added because every changed child is new", () => {
    renderTree({
      files: [dir("src")],
      changedFiles: [change("src/new.ts", "created"), change("src/deep/new.ts", "created")],
      includeMissingChanges: false,
    });
    expect(screen.getByText("src/")).toHaveClass("text-green-500");
    expect(screen.getByText("●")).toBeInTheDocument();
    expect(screen.queryByText("A")).toBeNull();
    expect(screen.getByRole("button", { name: "src/" })).toHaveAttribute(
      "aria-description",
      "src\nDescendants: 2 added",
    );
  });

  it.each(["created", "modified", "deleted"] as const)(
    "requires a typed directory record for its own %s label",
    (status) => {
      renderTree({
        files: [dir("src")],
        changedFiles: [{ ...change("src", status), type: "directory" }, change("src/edited.ts")],
        includeMissingChanges: false,
      });
      expect(screen.getByText("src/")).toHaveClass("text-amber-500");
      const letter = { created: "A", modified: "M", deleted: "D" }[status];
      expect(screen.getByText(letter)).toBeInTheDocument();
      expect(screen.queryByText("●")).toBeNull();
      expect(
        screen.getByRole("button", { name: "src/" }).getAttribute("aria-description"),
      ).toContain(
        `Folder: ${{ created: "Added", modified: "Modified", deleted: "Deleted" }[status]}\nDescendants: 1 modified`,
      );
    },
  );

  it("does not treat an untyped path match as independent directory status", () => {
    renderTree({
      files: [dir("src")],
      changedFiles: [change("src", "created")],
      includeMissingChanges: false,
    });
    expect(screen.queryByText("A")).toBeNull();
    expect(screen.queryByText("●")).toBeNull();
    expect(screen.getByRole("button", { name: "src/" })).toHaveAttribute("aria-description", "src");
  });

  it("keeps a deleted comparison file focusable for its status without opening it", async () => {
    const onFileSelect = vi.fn();
    renderTree({ files: [], changedFiles: [change("gone.ts", "deleted")], onFileSelect });
    const button = screen.getByRole("button", { name: "gone.ts" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.focus(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Deleted");
    fireEvent.click(button);
    expect(onFileSelect).not.toHaveBeenCalled();
  });
});

describe("FolderTree trailing column", () => {
  it("keeps loaded rows during a failed background refresh", () => {
    renderTree({
      files: [file("cached/kept.txt")],
      isError: true,
      error: new Error("Temporary connection failure"),
      conversationId: "cached-refresh-error",
    });
    expect(screen.getByRole("button", { name: "cached/" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "kept.txt" })).toBeInTheDocument();
  });

  it("suppresses browser list markers on virtualized file rows", () => {
    // Virtualized tree rows are no longer direct children of a <ul>, so the
    // file row's <li> must neutralize the browser's default bullet marker.
    renderTree({ files: [file("README.md")] });

    expect(screen.getByText("README.md").closest("li")).toHaveClass("list-none");
  });

  it("does not reserve a fixed action column for files or folders", () => {
    renderTree({ files: [file("tiny.txt", 985), file("huge.json", 474_000), dir("src")] });
    for (const size of ["985 B", "463 KB"]) {
      expect(screen.getByText(size).closest("[data-explorer-action]")).not.toHaveClass("w-[104px]");
    }
    expect(screen.queryByRole("button", { name: /^Copy (path|folder path):/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("FolderTree directory affordance", () => {
  it("shows the folder state at rest and swaps it for a directional chevron on hover", () => {
    renderTree({ files: [dir("src")], conversationId: "conv_folder_affordance" });

    const folderRow = screen.getByRole("button", { name: "src/" });
    const closedFolder = folderRow.querySelector(".lucide-folder");
    const chevron = folderRow.querySelector(".lucide-chevron-right");

    expect(closedFolder).not.toBeNull();
    expect(closedFolder?.parentElement).toHaveClass(
      "group-hover/folder:opacity-0",
      "group-focus-visible/folder:opacity-0",
    );
    expect(chevron).toHaveClass(
      "opacity-0",
      "group-hover/folder:opacity-100",
      "group-focus-visible/folder:opacity-100",
    );

    fireEvent.click(folderRow);

    expect(folderRow.querySelector(".lucide-folder-open")).not.toBeNull();
    expect(folderRow.querySelector(".lucide-chevron-right")).toHaveClass("rotate-90");
  });

  it("uses the interface body-text token for file and folder names", () => {
    renderTree({ files: [dir("src"), file("README.md")] });

    for (const label of [screen.getByText("src/"), screen.getByText("README.md")]) {
      expect(label).toHaveClass("text-ui");
      expect(label).not.toHaveClass("md:text-sm");
    }
    expect(screen.getByText("src/")).not.toHaveClass("font-mono");
    expect(screen.getByText("README.md")).not.toHaveClass("font-mono");
  });

  it("animates child rows before removing them on collapse", () => {
    vi.useFakeTimers();
    renderTree({
      files: [file("src/app.ts")],
      conversationId: "conv_folder_animation",
    });

    const folderRow = screen.getByRole("button", { name: "src/" });
    fireEvent.click(folderRow);

    expect(folderRow).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("app.ts").closest("[data-tree-motion]")).toHaveAttribute(
      "data-tree-motion",
      "exit",
    );

    act(() => vi.advanceTimersByTime(180));
    expect(screen.queryByText("app.ts")).toBeNull();

    fireEvent.click(folderRow);
    expect(screen.getByText("app.ts").closest("[data-tree-motion]")).toHaveAttribute(
      "data-tree-motion",
      "enter",
    );
  });
});

describe("FolderTree double-click navigation", () => {
  it("expands on single click and re-roots on double click", () => {
    const onNavigateDir = vi.fn();
    renderTree({ files: [dir("src"), file("README.md")], onNavigateDir });

    const folder = screen.getByRole("button", { name: "src/" });

    fireEvent.click(folder);
    expect(onNavigateDir).not.toHaveBeenCalled();

    fireEvent.doubleClick(folder);
    expect(onNavigateDir).toHaveBeenCalledWith("src");
  });

  it("passes a nested folder's relative path on double click", () => {
    const onNavigateDir = vi.fn();
    renderTree({ files: [file("src/components/Button.tsx")], onNavigateDir });

    fireEvent.doubleClick(screen.getByRole("button", { name: "components/" }));

    expect(onNavigateDir).toHaveBeenCalledWith("src/components");
  });
});

describe("FolderTree directory search results", () => {
  it("renders a matched directory as a folder row above matched files", () => {
    // The server-side search returns files AND directories; directories sort
    // first so a folder to open reads above the files sharing its name.
    renderTree({
      searchQuery: "src",
      searchResults: [file("src/main.py"), dir("src")],
    });

    const rows = screen.getAllByRole("listitem");
    // Folder row first (label carries the trailing slash), then the file.
    expect(rows[0]).toHaveTextContent("src/");
    expect(rows[1]).toHaveTextContent("src/main.py");
  });

  it("reveals the directory and exits search when a folder result is clicked", () => {
    // Clicking a folder in search behaves like clicking one in the tree: the
    // panel drops back to the tree (search cleared) with that folder expanded.
    const onExitSearch = vi.fn();
    const onFileSelect = vi.fn();
    renderTree({
      searchQuery: "src",
      searchResults: [dir("src/components")],
      onExitSearch,
      onFileSelect,
    });

    fireEvent.click(screen.getByRole("button", { name: /src\/components\// }));

    expect(onExitSearch).toHaveBeenCalledTimes(1);
    // A folder is not a file — it must not be opened in the viewer.
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it("scrolls to and flashes the revealed folder, expanding only its ancestors", async () => {
    // Search-mode is parent-controlled, so drive the whole flow through a
    // wrapper that clears searchQuery on exit — the way FilesPanel does. The
    // tree's own files show src/ containing sub/, so revealing "src/sub"
    // expands the ancestor (src) but leaves the target (sub) collapsed, then
    // scrolls it into view and flashes it.
    // jsdom leaves scrollTo undefined; the virtualizer's scrollToIndex calls
    // it, so define a no-op to keep the reveal effect from throwing.
    Object.defineProperty(Element.prototype, "scrollTo", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    lazyChildren.set("src", [dir("src/sub")]);

    function Harness() {
      const [query, setQuery] = useState("sub");
      return (
        <FolderTree
          files={[dir("src")]}
          isLoading={false}
          isError={false}
          error={null}
          onFileSelect={vi.fn()}
          conversationId="conv_reveal"
          showHidden={false}
          changedFiles={undefined}
          sort="alpha"
          searchQuery={query}
          searchResults={[dir("src/sub")]}
          onExitSearch={() => setQuery("")}
        />
      );
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    // Click the folder result → exit search, expand ancestors, reveal the row.
    fireEvent.click(screen.getByRole("button", { name: /src\/sub\// }));

    // The tree is back: the target row appears (ancestor src auto-expanded so
    // its lazy child sub/ renders) and carries the flash class while active.
    const subRow = await screen.findByRole("button", { name: "sub/" });
    const rowContainer = subRow.closest("div.group");
    expect(rowContainer).toHaveClass("animate-user-msg-flash");
    // The ancestor was auto-expanded (its lazy child rendered); the target
    // itself stays collapsed, like clicking a folder in the tree.
    expect(subRow).toHaveAttribute("aria-expanded", "false");
  });

  it("flashes a deep revealed folder once its ancestors' lazy levels resolve", async () => {
    // Reveal a deep target (a/b/target) whose ancestors' listings arrive in
    // separate lazy steps, so `flatRows` changes several times before the row
    // materializes. The scroll/flash effect re-runs on each change but is gated
    // (pendingRevealRef) to act once the row first appears — the highlight
    // lands on exactly the target and no other row.
    Object.defineProperty(Element.prototype, "scrollTo", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    lazyChildren.set("a", [dir("a/b")]);
    lazyChildren.set("a/b", [dir("a/b/target")]);

    function Harness() {
      const [query, setQuery] = useState("target");
      return (
        <FolderTree
          files={[dir("a")]}
          isLoading={false}
          isError={false}
          error={null}
          onFileSelect={vi.fn()}
          conversationId="conv_reveal_deep"
          showHidden={false}
          changedFiles={undefined}
          sort="alpha"
          searchQuery={query}
          searchResults={[dir("a/b/target")]}
          onExitSearch={() => setQuery("")}
        />
      );
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /a\/b\/target\// }));

    // Wait for the deep row to materialize after both lazy levels resolve.
    const targetRow = await screen.findByRole("button", { name: "target/" });
    expect(targetRow.closest("div.group")).toHaveClass("animate-user-msg-flash");
    // Exactly one row flashes — the reveal doesn't smear the highlight across
    // ancestors as their levels land.
    expect(container.querySelectorAll(".animate-user-msg-flash")).toHaveLength(1);
  });
});

describe("FolderTree change-status overlay", () => {
  it.each([
    { browseLocation: "/outside/repo", workspaceRoot: "/work", path: "/outside/repo/app.ts" },
    { browseLocation: "/work/src", workspaceRoot: "/work", path: "src/app.ts" },
    { browseLocation: "src", workspaceRoot: "/work", path: "/work/src/app.ts" },
    { browseLocation: "", workspaceRoot: "/work", path: "/work/app.ts" },
    { browseLocation: "/", workspaceRoot: null, path: "/app.ts" },
  ])("scopes Git paths for $browseLocation ($path)", ({ browseLocation, workspaceRoot, path }) => {
    renderTree({
      conversationId: `scope-${path}-${browseLocation}`,
      files: [file("app.ts")],
      changedFiles: [change(path), change("/outside/repo-other/unrelated.ts")],
      browseLocation,
      workspaceRoot,
      includeMissingChanges: false,
    });
    expect(screen.getByText("app.ts")).toHaveClass("text-amber-500");
    expect(screen.getByText("M")).toHaveTextContent("M");
    expect(screen.queryByText("unrelated.ts")).not.toBeInTheDocument();
  });

  it("keeps only filesystem entries when missing change synthesis is disabled", async () => {
    lazyChildren.clear();
    lazyChildren.set("repo", [file("repo/live.ts")]);
    renderTree({
      conversationId: "no-missing-changes",
      files: [dir("repo")],
      changedFiles: [
        change("repo/live.ts"),
        change("repo/gone.ts", "deleted"),
        change("old/gone.ts", "deleted"),
      ],
      includeMissingChanges: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "repo/" }));
    expect(await screen.findByText("live.ts")).toHaveClass("text-amber-500");
    expect(screen.queryByText("gone.ts")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "old/" })).not.toBeInTheDocument();
  });

  it("adds API-only created and deleted files to the tree with status badges", async () => {
    lazyChildren.clear();
    lazyChildren.set("src", [file("src/live.ts")]);
    renderTree({
      files: [dir("src")],
      conversationId: "conv_change_overlay",
      changedFiles: [
        {
          path: "new.ts",
          name: "new.ts",
          status: "created",
          bytes: 12,
          modified_at: null,
          lines_added: null,
          lines_removed: null,
        },
        {
          path: "src/gone.ts",
          name: "gone.ts",
          status: "deleted",
          bytes: null,
          modified_at: null,
          lines_added: null,
          lines_removed: null,
        },
      ],
    });

    expect(screen.getByText("new.ts")).toHaveClass("text-green-500");
    expect(screen.getByText("new.ts")).not.toHaveClass("font-semibold");
    expect(screen.getByText("A")).toHaveTextContent("A");

    fireEvent.click(screen.getByRole("button", { name: "src/" }));
    const deleted = await screen.findByText("gone.ts");
    expect(deleted).toHaveClass("line-through");
    expect(deleted).not.toHaveClass("text-destructive");
    expect(deleted.closest("div.group")).toHaveClass("opacity-50");
    expect(screen.getByText("D")).toHaveTextContent("D");
  });

  it("matches workspace-root change paths after re-rooting into a subfolder", () => {
    renderTree({
      files: [file("app.ts")],
      browseLocation: "src",
      changedFiles: [
        {
          path: "src/app.ts",
          name: "app.ts",
          status: "modified",
          bytes: 12,
          modified_at: null,
          lines_added: null,
          lines_removed: null,
        },
      ],
    });

    expect(screen.getByText("app.ts")).toHaveClass("text-amber-500");
    expect(screen.getByText("M")).toHaveTextContent("M");
  });
});

describe("FolderTree directory discovery", () => {
  it("reports stable sorted snapshots of the root and expanded directories", async () => {
    lazyChildren.clear();
    lazyChildren.set("z", [dir("z/deep")]);
    const onDirectoriesChange = vi.fn();
    const view = renderTree({
      conversationId: "directory-snapshots",
      files: [dir("z"), file("a/live.ts")],
      onDirectoriesChange,
    });
    expect(onDirectoriesChange).toHaveBeenLastCalledWith(["", "a"]);
    fireEvent.click(screen.getByRole("button", { name: "z/" }));
    expect(onDirectoriesChange).toHaveBeenLastCalledWith(["", "a", "z"]);
    fireEvent.click(await screen.findByRole("button", { name: "deep/" }));
    expect(onDirectoriesChange).toHaveBeenLastCalledWith(["", "a", "z", "z/deep"]);
    const count = onDirectoriesChange.mock.calls.length;
    fireEvent.focus(screen.getByRole("button", { name: "z/" }));
    expect(onDirectoriesChange).toHaveBeenCalledTimes(count);
    fireEvent.click(screen.getByRole("button", { name: "z/" }));
    await waitFor(() => expect(onDirectoriesChange).toHaveBeenLastCalledWith(["", "a", "z/deep"]));
    view.unmount();
  });
});

describe("FolderTree Git-ignore metadata", () => {
  it.each([false, true])(
    "keeps explicit directory metadata when children come first: %s",
    (childrenFirst) => {
      const directory = { ...dir("cache"), git_ignored: true };
      const child = { ...file("cache/ignored.log"), git_ignored: true };
      renderTree({
        conversationId: `conv_ignored_order_${childrenFirst}`,
        files: childrenFirst ? [child, directory] : [directory, child],
      });

      expect(screen.getByText("cache/")).toHaveClass("opacity-50");
      expect(screen.getByRole("button", { name: "cache/" })).toHaveAttribute(
        "aria-description",
        "cache\nIgnored by Git",
      );
    },
  );
});

describe("FolderTree nested lazy loading", () => {
  beforeEach(() => {
    lazyChildren.clear();
    lazyErrors.clear();
  });

  it("dims ignored icons and names without dimming descendants or disabling actions", async () => {
    lazyChildren.set("cache", [
      { ...dir("cache/nested"), git_ignored: true },
      { ...file("cache/ignored.log"), git_ignored: true },
      { ...file("cache/tracked.txt"), git_ignored: false },
      file("cache/legacy.txt"),
    ]);
    lazyChildren.set("cache/nested", [{ ...file("cache/nested/deep.log"), git_ignored: true }]);
    const onFileSelect = vi.fn();
    const onNavigateDir = vi.fn();
    renderTree({
      conversationId: "conv_ignored_expansion",
      files: [{ ...dir("cache"), git_ignored: true }],
      onFileSelect,
      onNavigateDir,
    });

    fireEvent.click(screen.getByRole("button", { name: "cache/" }));
    fireEvent.click(await screen.findByRole("button", { name: "nested/" }));
    expect(await screen.findByText("deep.log")).toBeInTheDocument();

    for (const name of ["cache/", "nested/", "ignored.log", "deep.log"]) {
      const label = screen.getByText(name);
      const button = label.closest("button");
      expect(label).toHaveClass("opacity-50");
      expect(label.parentElement?.closest(".opacity-50")).toBeNull();
      expect(button?.querySelector("svg")?.closest(".opacity-50")).not.toBeNull();
      expect(button?.getAttribute("aria-description")).toContain("Ignored by Git");
      expect(button).not.toHaveAttribute("title");
      expect(button).toBeEnabled();
    }
    for (const name of ["tracked.txt", "legacy.txt"]) {
      const label = screen.getByText(name);
      expect(label.closest(".opacity-50")).toBeNull();
      expect(label.closest("button")).not.toHaveAttribute("title");
    }

    fireEvent.click(screen.getByText("ignored.log"));
    expect(onFileSelect).toHaveBeenCalledWith("cache/ignored.log");
    fireEvent.doubleClick(screen.getByRole("button", { name: "nested/" }));
    expect(onNavigateDir).toHaveBeenCalledWith("cache/nested");
    expect(screen.queryByRole("button", { name: "Copy folder path: nested" })).toBeNull();
  });

  it("shows an error row when a lazy directory's listing fails", async () => {
    lazyErrors.add("src");
    renderTree({ files: [dir("src")], conversationId: "conv_lazy_error" });

    fireEvent.click(screen.getByRole("button", { name: "src/" }));

    expect(await screen.findByText("Failed to load this folder.")).toBeInTheDocument();
  });

  it("loads a deep lazy level on a restored multi-level expansion (no per-level clicks)", async () => {
    // Regression guard for B1. The bug only shows on RESTORE/RE-ROOT, where a
    // multi-level expansion is seeded at once rather than clicked open level by
    // level — interactive expansion masks it, because each click mutates
    // expandedPaths and re-runs the fetch-set computation anyway. Here we build
    // the expansion with clicks (which caches src + src/deep as expanded), then
    // REMOUNT: the fresh tree seeds both expanded paths from the cache in one
    // shot, and its fetch set starts from nothing. The controller must widen
    // past the first level on its own as src's listing lands, or src/deep never
    // fetches and renders as an empty folder. A fetch-set computation that
    // ignores freshly-arrived data resolves only src and leaves leaf.ts missing.
    const conversationId = "conv_restore_deep";
    lazyChildren.set("src", [dir("src/deep")]);
    lazyChildren.set("src/deep", [file("src/deep/leaf.ts", 42)]);

    const { unmount } = renderTree({ files: [dir("src")], conversationId });
    fireEvent.click(screen.getByRole("button", { name: "src/" }));
    fireEvent.click(await screen.findByRole("button", { name: "deep/" }));
    expect(await screen.findByText("leaf.ts")).toBeInTheDocument();

    // Restore: remount the same conversation. Expansion comes back from the
    // cache with no clicks; the deep level must fetch and render on its own.
    unmount();
    renderTree({ files: [dir("src")], conversationId });
    expect(await screen.findByText("leaf.ts")).toBeInTheDocument();
  });
});

describe("FolderTree default expansion on conversation switch", () => {
  const baseProps = {
    isLoading: false,
    isError: false,
    error: null,
    onFileSelect: vi.fn(),
    showHidden: false,
    changedFiles: undefined,
    sort: "alpha" as const,
  };

  it("seeds a switched-to conversation's expansion from its own files, not the previous one's", () => {
    // Regression guard: FolderTree isn't keyed by conversation, so a switch
    // re-renders the same instance and a layout effect seeds the new
    // conversation's default-expansion cache. The All-files query intentionally
    // drops cross-key placeholderData, so on a real switch `files` goes
    // undefined before the new conversation's list arrives — the effect must
    // early-return on that undefined frame and then seed defaults from the NEW
    // conversation's files. (A cross-key placeholder would instead leave the
    // previous conversation's files on screen under the new key, seeding it
    // with the wrong auto-expanded folders for the rest of the session.)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (conversationId: string, files: WorkspaceFile[] | undefined) => (
      <QueryClientProvider client={client}>
        <FolderTree {...baseProps} conversationId={conversationId} files={files} />
      </QueryClientProvider>
    );

    // Conversation A: a nested file makes its intermediate dir auto-expand.
    const { rerender } = render(view("conv_A", [file("alpha/a.ts")]));
    expect(screen.getByText("a.ts")).toBeInTheDocument();

    // Switch to B: with no cross-key placeholder the files blank to undefined
    // first, then B's real files arrive.
    rerender(view("conv_B", undefined));
    rerender(view("conv_B", [file("beta/b.ts")]));

    // B auto-expands its OWN nested dir; A's folder is gone entirely.
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.queryByText("a.ts")).toBeNull();
    expect(screen.getByRole("button", { name: "beta/" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("FolderTree truncated search", () => {
  it("says the scan stopped early instead of a flat no-match when results were truncated", () => {
    // A repo larger than the server's scan budget returns zero matches AND
    // truncated=true; presenting that as "No files match" told users a file
    // they could see on disk did not exist.
    renderTree({ searchQuery: "reyden", searchResults: [], searchTruncated: true });

    expect(screen.getByText(/No files match "reyden"/)).toHaveTextContent(
      "the search stopped early, so results may be incomplete",
    );
  });

  it("keeps the truncation note when every match is in a hidden directory", () => {
    // The hidden-only branch replaces the results list with a "show hidden"
    // prompt; a truncated scan still has to be distinguishable there.
    renderTree({
      searchQuery: "env",
      searchResults: [file(".env")],
      searchTruncated: true,
    });

    expect(screen.getByText(/in hidden directories/)).toHaveTextContent(
      "Search stopped early — results may be incomplete.",
    );
  });

  it("footnotes partial results when the scan was truncated", () => {
    renderTree({
      searchQuery: "main",
      searchResults: [file("src/main.py")],
      searchTruncated: true,
    });

    expect(screen.getByText("src/main.py")).toBeInTheDocument();
    expect(
      screen.getByText("Search stopped early — results may be incomplete."),
    ).toBeInTheDocument();
  });
});
