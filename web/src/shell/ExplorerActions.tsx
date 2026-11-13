// Modified for Triune.
import { useExplorerSelection } from "@/lib/explorerSelection";
import { useResourceViewId, useResourceViewState } from "@/lib/panelFolder";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import {
  FilePlusIcon,
  FolderPlusIcon,
  CopyMinusIcon,
  CopyIcon,
  ScissorsIcon,
  ClipboardPasteIcon,
  DownloadIcon,
  FolderOpenIcon,
  FolderInputIcon,
  PencilIcon,
  Trash2Icon,
  Undo2Icon,
  RefreshCwIcon,
  SquareCheckIcon,
  SquareIcon,
  MoreHorizontalIcon,
  SearchIcon,
  UploadIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useWorkbenchWorkspace, queryIdentity } from "@/lib/workbenchWorkspace";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notifications";
import { formatBytes } from "./fileStatusUtils";
import { useFileDropTarget } from "@/hooks/useFileDropTarget";
import { FileDropOverlay } from "@/components/FileDropOverlay";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/clipboard";
import {
  absoluteExplorerPath,
  basename,
  childPath,
  distinctRoots,
  droppedUploads,
  filesystemOperation,
  FilesystemOperationError,
  parentPath,
  selectionRange,
  type ExplorerEntry,
  type FilesystemOperationResult,
  type TrashEntry,
  type UploadItem,
} from "@/lib/explorerOperations";
import { joinBrowseLocation, relativizeToWorkspace } from "@/hooks/useWorkspaceChangedFiles";
import { FileViewerContext } from "./FileViewerContext";
import {
  getExplorerTransfers,
  startExplorerArchive,
  startExplorerUpload,
  subscribeExplorerTransfers,
  transferIsActive,
} from "@/lib/explorerTransfers";
import {
  RevealBaseContext,
  revealInFileManager,
  revealLabel,
  useRevealTarget,
} from "./RevealInFileManager";

const DRAG_TYPE = "application/x-omnigent-files";
interface ExplorerClipboard {
  conversationId: string;
  hostId: string | null;
  entries: ExplorerEntry[];
  cut: boolean;
}
let clipboard: ExplorerClipboard | null = null;

interface TreeControls {
  entries: ExplorerEntry[];
  navigate?: (path: string, key: string) => string | null;
  collapse?: () => void;
  reveal?: (path: string) => void;
}
interface ExplorerContextValue {
  conversationId: string | undefined;
  base: string;
  entryBase: string;
  writable: boolean;
  selected: Map<string, ExplorerEntry>;
  selectionMode: boolean;
  focused: string | null;
  registerTree: (controls: TreeControls) => () => void;
  openMenu: (entry: ExplorerEntry, x: number, y: number) => void;
  select: (entry: ExplorerEntry, additive: boolean, range: boolean) => void;
  setFocused: (path: string) => void;
  startDrag: (entry: ExplorerEntry, transfer: DataTransfer) => void;
  drop: (entry: ExplorerEntry, transfer: DataTransfer, copy: boolean) => void;
  download: (entries: ExplorerEntry[]) => Promise<void>;
  newItem: (directory: boolean, parent?: string) => void;
  search: (path: string) => void;
  collapse: () => void;
  reveal: () => void;
  menu: (target: ExplorerEntry) => ReactNode;
  toolbarMenu: (viewOptions?: ReactNode) => ReactNode;
  chooseUpload: (directory: boolean, path?: string) => void;
  busy: boolean;
  isDragActive: boolean;
}
const ExplorerContext = createContext<ExplorerContextValue | null>(null);

function RevealFileMenuItem({ entry }: { entry: ExplorerEntry }) {
  const target = useRevealTarget(entry.path);
  return target ? (
    <DropdownMenuItem onSelect={() => revealInFileManager(target)}>
      <FolderOpenIcon />
      {revealLabel(entry.directory)}
    </DropdownMenuItem>
  ) : null;
}

export function useExplorerTree(controls: TreeControls): void {
  const registerTree = useContext(ExplorerContext)?.registerTree;
  useEffect(() => registerTree?.(controls), [registerTree, controls]);
}

export function useExplorerRow(path: string, directory: boolean, deleted = false) {
  const ctx = useContext(ExplorerContext);
  const viewer = useContext(FileViewerContext);
  const revealBase = useContext(RevealBaseContext);
  const canonical = joinBrowseLocation(ctx?.entryBase ?? revealBase, path);
  const active =
    !directory &&
    !!viewer?.activeFilePath &&
    relativizeToWorkspace(viewer.activeFilePath, viewer.workspaceRoot) ===
      relativizeToWorkspace(canonical, viewer.workspaceRoot);
  const currentProps = { "aria-current": active ? ("true" as const) : undefined };
  const entry = { path: canonical, directory };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  useEffect(() => {
    if (!ctx?.isDragActive) {
      clearTimeout(timer.current ?? undefined);
      timer.current = null;
    }
  }, [ctx?.isDragActive]);
  if (!ctx || deleted)
    return {
      selected: false,
      active,
      props: currentProps as HTMLAttributes<HTMLDivElement>,
      path: canonical,
    };
  const props: HTMLAttributes<HTMLDivElement> & {
    "data-explorer-entry": string;
    "data-directory": string;
  } = {
    ...currentProps,
    "data-explorer-entry": canonical,
    "data-directory": String(directory),
    role: "treeitem",
    "aria-selected": ctx.selected.has(canonical),
    tabIndex: ctx.focused === canonical ? 0 : -1,
    draggable: ctx.writable,
    onFocus: () => ctx.setFocused(canonical),
    onClickCapture: (event) => {
      if ((event.target as HTMLElement).closest("[data-explorer-action]")) return;
      const button = (event.target as HTMLElement).closest("button");
      if (button && button !== event.currentTarget.querySelector("button")) return;
      ctx.select(entry, ctx.selectionMode || event.metaKey || event.ctrlKey, event.shiftKey);
      if (ctx.selectionMode || event.metaKey || event.ctrlKey || event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
      }
    },
    onDoubleClickCapture: (event) => {
      if (ctx.selectionMode || event.ctrlKey || event.metaKey || event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      const box = event.currentTarget.getBoundingClientRect();
      ctx.openMenu(entry, event.clientX || box.left, event.clientY || box.bottom);
    },
    onDragStart: (event) => {
      event.stopPropagation();
      ctx.startDrag(entry, event.dataTransfer);
    },
    onDragOver:
      directory && ctx.writable
        ? (event) => {
            if (
              !Array.from(event.dataTransfer.types ?? []).some(
                (type) => type === "Files" || type === DRAG_TYPE,
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.dataset.dropTarget = "true";
            event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? "copy" : "move";
            const toggle = event.currentTarget.querySelector<HTMLButtonElement>(
              "button[aria-expanded='false']",
            );
            if (toggle && !timer.current)
              timer.current = setTimeout(() => {
                toggle.click();
                timer.current = null;
              }, 650);
          }
        : undefined,
    onDragLeave: (event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      delete event.currentTarget.dataset.dropTarget;
      clearTimeout(timer.current ?? undefined);
      timer.current = null;
    },
    onDragEnd: (event) => {
      delete event.currentTarget.dataset.dropTarget;
      clearTimeout(timer.current ?? undefined);
      timer.current = null;
    },
  };
  return { selected: ctx.selected.has(canonical), active, props, path: canonical };
}

interface ActionDialog {
  kind: "new-file" | "new-folder" | "rename" | "move" | "duplicate" | "trash";
  entries: ExplorerEntry[];
  parent: string;
}
interface PendingUpload {
  files: UploadItem[];
  directories: string[];
  destination: string;
}

export function ExplorerActionsProvider({
  children,
  conversationId,
  base,
  entryBase = base,
  workspaceRoot,
  hostId,
  writable,
  onRefresh,
  onRevealFile,
}: {
  children: ReactNode;
  conversationId: string | undefined;
  base: string;
  /** Row paths use the workspace root in Changes, independently of the operation folder. */
  entryBase?: string;
  workspaceRoot: string | null;
  hostId: string | null;
  writable: boolean;
  onRefresh: () => Promise<void>;
  onRevealFile?: (path: string) => void;
}) {
  const workspace = useWorkbenchWorkspace();
  const resourceIdentity = queryIdentity(workspace, conversationId);
  const viewId = useResourceViewId();
  const queryClient = useContext(QueryClientContext);
  const viewer = useContext(FileViewerContext);
  const { selected, setSelected, anchor } = useExplorerSelection(resourceIdentity, base);
  const [selectionMode, setSelectionMode] = useResourceViewState(
    `${resourceIdentity}:${base}`,
    viewId,
    "selectionMode",
    false,
  );
  const [focused, setFocused] = useResourceViewState<string | null>(
    `${resourceIdentity}:${base}`,
    viewId,
    "focusedEntry",
    null,
  );
  const tree = useRef<TreeControls>({ entries: [] });
  const root = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<HTMLDivElement | null>(null);
  const [dropHint, setDropHint] = useState("");
  const setRoot = useCallback((element: HTMLDivElement | null) => {
    root.current = element;
    setDropTarget(element);
  }, []);
  const [point, setPoint] = useState<{ entry: ExplorerEntry; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<ActionDialog | null>(null);
  const [value, setValue] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [localBusy, setBusy] = useState(false);
  const transfers = useSyncExternalStore(subscribeExplorerTransfers, getExplorerTransfers);
  const busy =
    localBusy ||
    transfers.some(
      (transfer) => transfer.conversationId === resourceIdentity && transferIsActive(transfer),
    );
  const busyRef = useRef(false);
  const [trash, setTrash] = useState<TrashEntry[] | null>(null);
  const [upload, setUpload] = useState<PendingUpload | null>(null);
  const [pasteConflict, setPasteConflict] = useState<{
    clipboard: ExplorerClipboard;
    destination: string;
  } | null>(null);
  const uploadDestination = useRef(base);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const registerTree = useCallback(
    (controls: TreeControls) => {
      tree.current = {
        ...controls,
        entries: controls.entries.map((entry) => ({
          ...entry,
          path: joinBrowseLocation(entryBase, entry.path),
        })),
      };
      return () => {
        if (tree.current.navigate === controls.navigate) tree.current = { entries: [] };
      };
    },
    [entryBase],
  );
  useEffect(() => {
    if (viewId) return;
    setFocused(null);
    setSelectionMode(false);
  }, [resourceIdentity, base, viewId, setFocused, setSelectionMode]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (queryClient && resourceIdentity) {
      await Promise.all(
        [
          "workspace-dir",
          "workspace-dir-listing",
          "workspace-all-files",
          "workspace-changed-files",
          "workspace-comparison-changes",
          "workspace-file-search",
          "file-content",
          "file-diff",
          "content-search-result",
        ].map((key) => queryClient.invalidateQueries({ queryKey: [key, resourceIdentity] })),
      );
    }
    if (mounted.current) await onRefresh();
  }, [resourceIdentity, onRefresh, queryClient]);

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    if (
      getExplorerTransfers().some(
        (transfer) => transfer.conversationId === resourceIdentity && transferIsActive(transfer),
      )
    ) {
      toast.warning("A file transfer is already running in this workspace.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      toast.error("File operation failed", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const operation = async (body: Record<string, unknown>): Promise<FilesystemOperationResult> => {
    if (!conversationId && !workspace) throw new Error("Select a workspace before managing files.");
    const result = workspace
      ? await filesystemOperation(conversationId ?? "", body, undefined, workspace)
      : await filesystemOperation(conversationId!, {
          ...body,
          ...(workspaceRoot &&
          queryClient?.getQueryData<{ workspaceRevision?: string }>(["session", conversationId])
            ?.workspaceRevision
            ? { workspace_root: workspaceRoot }
            : {}),
        });
    if (body.operation !== "archive" && body.operation !== "trash_list") {
      window.dispatchEvent(
        new CustomEvent("omnigent:workspace-files-changed", {
          detail: {
            conversationId,
            ...(workspace ? { workspaceId: workspace.id } : {}),
            moves: (result.moved ?? []).map((move) => ({
              source: relativizeToWorkspace(move.source, workspaceRoot),
              destination: relativizeToWorkspace(move.destination, workspaceRoot),
            })),
            removed:
              body.operation === "trash"
                ? (body.paths as string[]).map((path) => relativizeToWorkspace(path, workspaceRoot))
                : [],
          },
        }),
      );
      setSelected(new Map());
      await refresh();
    }
    return result;
  };
  const picked = (target: ExplorerEntry) =>
    distinctRoots(selected.has(target.path) ? [...selected.values()] : [target]);
  const destinationFor = (target: ExplorerEntry) =>
    target.directory ? target.path : parentPath(target.path);
  const search = (path: string) => {
    if (viewer?.openContentSearch) {
      viewer.openContentSearch(path);
      return;
    }
    window.dispatchEvent(
      new CustomEvent("omnigent:open-content-search", {
        detail: {
          conversationId,
          ...(workspace ? { workspaceId: workspace.id } : {}),
          location: path,
        },
      }),
    );
  };
  const openDialog = (kind: ActionDialog["kind"], entries: ExplorerEntry[], parent = base) => {
    setOverwrite(false);
    setValue(
      kind === "rename"
        ? basename(entries[0].path)
        : kind === "duplicate"
          ? `${basename(entries[0].path)}.copy`
          : kind === "move"
            ? parent
            : "",
    );
    setDialog({ kind, entries, parent });
  };
  const chooseUpload = (directory: boolean, path = base) => {
    uploadDestination.current = path;
    (directory ? folderInput : fileInput).current?.click();
  };
  const setClipboard = async (entries: ExplorerEntry[], cut: boolean) => {
    clipboard = {
      conversationId: resourceIdentity ?? "",
      hostId,
      cut,
      entries: distinctRoots(entries).map((entry) => ({
        ...entry,
        path: workspaceRoot ? absoluteExplorerPath(workspaceRoot, entry.path) : entry.path,
      })),
    };
    await copyText(clipboard.entries.map((entry) => entry.path).join("\n"));
  };
  const paste = async (destination: string, clip = clipboard, overwriteExisting = false) => {
    if (!clip) throw new Error("Copy or cut files in the Explorer first.");
    if (clip.conversationId !== resourceIdentity && (!hostId || hostId !== clip.hostId))
      throw new Error("Files can only be pasted on the same host.");
    const entries = clip.entries.map((entry) => {
      const source = workspaceRoot ? relativizeToWorkspace(entry.path, workspaceRoot) : entry.path;
      return { source, destination: childPath(destination, basename(entry.path)) };
    });
    try {
      await operation({
        operation: clip.cut ? "move" : "copy",
        entries,
        overwrite: overwriteExisting,
      });
    } catch (cause) {
      if (
        !overwriteExisting &&
        ((cause instanceof FilesystemOperationError && cause.status === 409) ||
          (cause instanceof Error && /already exists|file exists/i.test(cause.message)))
      ) {
        setPasteConflict({ clipboard: clip, destination });
        return;
      }
      throw cause;
    }
    if (clip.cut && clip === clipboard) clipboard = null;
  };
  const download = async (entries: ExplorerEntry[]) => {
    if (conversationId || workspace)
      startExplorerArchive(
        conversationId ?? "",
        distinctRoots(entries).map((entry) => entry.path),
        workspace ?? undefined,
      );
  };
  const loadTrash = async () => {
    const result = await operation({ operation: "trash_list", path: base });
    setTrash(result.items ?? []);
  };
  const menu = (target: ExplorerEntry) => {
    const entries = picked(target);
    const folder = destinationFor(target);
    return (
      <>
        <DropdownMenuItem
          disabled={!writable || busy}
          onSelect={() => openDialog("new-file", [], folder)}
        >
          New file…
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!writable || busy}
          onSelect={() => openDialog("new-folder", [], folder)}
        >
          New folder…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => search(folder)}>Search in folder…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!writable || busy} onSelect={() => chooseUpload(false, folder)}>
          Upload files…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!writable || busy} onSelect={() => chooseUpload(true, folder)}>
          Upload folder…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={() => void run(() => download(entries))}>
          Download as ZIP
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!writable || busy || !target.path}
          onSelect={() => void run(() => setClipboard(entries, true))}
        >
          Cut
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy || !target.path}
          onSelect={() => void run(() => setClipboard(entries, false))}
        >
          Copy
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!writable || busy || !clipboard}
          onSelect={() => void run(() => paste(folder))}
        >
          Paste
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!writable || busy || entries.length !== 1 || !target.path}
          onSelect={() => openDialog("rename", entries)}
        >
          Rename…
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!writable || busy || !target.path}
          onSelect={() => openDialog("move", entries, folder)}
        >
          Move to…
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!writable || busy || entries.length !== 1 || !target.path}
          onSelect={() => openDialog("duplicate", entries)}
        >
          Duplicate…
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!writable || busy || !target.path}
          variant="destructive"
          onSelect={() => openDialog("trash", entries)}
        >
          Move to trash…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            void run(() =>
              copyText(
                workspaceRoot ? absoluteExplorerPath(workspaceRoot, target.path) : target.path,
              ),
            )
          }
        >
          Copy path
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run(() => copyText(target.path))}>
          Copy relative path
        </DropdownMenuItem>
        <RevealFileMenuItem entry={target} />
        <DropdownMenuItem disabled={!writable || busy} onSelect={() => void run(loadTrash)}>
          Restore deleted files…
        </DropdownMenuItem>
      </>
    );
  };

  const toolbarMenu = (viewOptions?: ReactNode) => {
    const entries = distinctRoots([...selected.values()]);
    const hasSelection = entries.length > 0;
    const folder = { path: base, directory: true };
    return (
      <>
        <DropdownMenuLabel>Transfers</DropdownMenuLabel>
        <DropdownMenuItem disabled={!writable || busy} onSelect={() => chooseUpload(false, base)}>
          <UploadIcon />
          Upload files into this folder…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!writable || busy} onSelect={() => chooseUpload(true, base)}>
          <FolderPlusIcon />
          Upload folder into this folder…
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => void run(() => download(hasSelection ? entries : [folder]))}
        >
          <DownloadIcon />
          {hasSelection ? "Download selection as ZIP" : "Download this folder as ZIP"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Navigation and search · current folder</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => search(base)}>
          <SearchIcon />
          Search folder contents…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            void run(() =>
              copyText(
                workspaceRoot
                  ? base
                    ? absoluteExplorerPath(workspaceRoot, base)
                    : workspaceRoot
                  : base,
              ),
            )
          }
        >
          <CopyIcon />
          Copy folder path
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run(() => copyText(base))}>
          <CopyIcon />
          Copy relative folder path
        </DropdownMenuItem>
        <RevealFileMenuItem entry={folder} />
        {viewOptions && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>View options</DropdownMenuLabel>
            {viewOptions}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {hasSelection ? `Selection · ${entries.length} selected` : "Selection"}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => {
            setSelectionMode(!selectionMode);
            if (selectionMode) setSelected(new Map());
          }}
        >
          <SquareCheckIcon />
          {selectionMode ? "Done selecting" : "Select files…"}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={tree.current.entries.length === 0}
          onSelect={() =>
            setSelected(new Map(tree.current.entries.map((entry) => [entry.path, entry])))
          }
        >
          <SquareCheckIcon />
          Select all visible files
        </DropdownMenuItem>
        {hasSelection && (
          <>
            <DropdownMenuItem onSelect={() => setSelected(new Map())}>
              <SquareIcon />
              Clear selection
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!writable || busy}
              onSelect={() => void run(() => setClipboard(entries, true))}
            >
              <ScissorsIcon />
              Cut selected items
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => void run(() => setClipboard(entries, false))}
            >
              <CopyIcon />
              Copy selected items
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!writable || busy || entries.length !== 1}
              onSelect={() => openDialog("rename", entries)}
            >
              <PencilIcon />
              Rename selected item…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!writable || busy}
              onSelect={() => openDialog("move", entries, base)}
            >
              <FolderInputIcon />
              Move selected items to…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!writable || busy || entries.length !== 1}
              onSelect={() => openDialog("duplicate", entries)}
            >
              <CopyIcon />
              Duplicate selected item…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!writable || busy}
              variant="destructive"
              onSelect={() => openDialog("trash", entries)}
            >
              <Trash2Icon />
              Move selected items to trash…
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem
          disabled={!writable || busy || !clipboard}
          onSelect={() => void run(() => paste(base))}
        >
          <ClipboardPasteIcon />
          Paste into this folder
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Recovery · current folder</DropdownMenuLabel>
        <DropdownMenuItem disabled={!writable || busy} onSelect={() => void run(loadTrash)}>
          <Undo2Icon />
          Restore deleted files…
        </DropdownMenuItem>
      </>
    );
  };

  const select = (entry: ExplorerEntry, additive: boolean, range: boolean) => {
    setFocused(entry.path);
    if (range) {
      const rangeEntries = selectionRange(tree.current.entries, anchor.current, entry);
      setSelected(
        new Map(
          (additive ? [...selected.values(), ...rangeEntries] : rangeEntries).map((item) => [
            item.path,
            item,
          ]),
        ),
      );
      if (anchor.current === null) anchor.current = entry.path;
      return;
    }
    if (!additive) {
      anchor.current = entry.path;
      setSelected(new Map([[entry.path, entry]]));
      return;
    }
    const next = new Map(selected);
    if (next.has(entry.path)) {
      next.delete(entry.path);
      if (anchor.current === entry.path) anchor.current = [...next.keys()].at(-1) ?? null;
    } else {
      next.set(entry.path, entry);
      anchor.current = entry.path;
    }
    setSelected(next);
  };
  const openMenu = (entry: ExplorerEntry, x: number, y: number) => {
    if (!selected.has(entry.path)) {
      setSelected(new Map([[entry.path, entry]]));
      anchor.current = entry.path;
    }
    setFocused(entry.path);
    setPoint({ entry, x, y });
  };
  const startDrag = (entry: ExplorerEntry, transfer: DataTransfer) => {
    const clip: ExplorerClipboard = {
      conversationId: resourceIdentity ?? "",
      hostId,
      cut: true,
      entries: picked(entry).map((item) => ({
        ...item,
        path: workspaceRoot ? absoluteExplorerPath(workspaceRoot, item.path) : item.path,
      })),
    };
    transfer.setData(DRAG_TYPE, JSON.stringify(clip));
    transfer.effectAllowed = "copyMove";
  };
  const drop = (entry: ExplorerEntry, transfer: DataTransfer, copy: boolean) => {
    const internal = transfer.getData(DRAG_TYPE);
    if (internal) {
      void run(async () => {
        const clip = JSON.parse(internal) as ExplorerClipboard;
        if (!Array.isArray(clip.entries)) throw new Error("Invalid file drop.");
        await paste(destinationFor(entry), { ...clip, cut: !copy });
      });
    } else {
      void run(async () => {
        const pending = await droppedUploads(transfer);
        setUpload({ ...pending, destination: destinationFor(entry) });
        setOverwrite(false);
      });
    }
  };

  const dropEntry = (event: DragEvent): ExplorerEntry => {
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-explorer-entry]")
        : null;
    return row?.dataset.explorerEntry
      ? { path: row.dataset.explorerEntry, directory: row.dataset.directory === "true" }
      : { path: base, directory: true };
  };
  const isDragActive = useFileDropTarget(writable ? dropTarget : null, () => {}, {
    additionalTypes: [DRAG_TYPE],
    capture: true,
    onDragOver: (event) => {
      const internal = Array.from(event.dataTransfer?.types ?? []).includes(DRAG_TYPE);
      const action = internal ? (event.ctrlKey || event.metaKey ? "Copy" : "Move") : "Upload";
      setDropHint(`${action} to ${destinationFor(dropEntry(event)) || "workspace root"}`);
    },
    onDrop: (event) => {
      event.stopPropagation();
      drop(dropEntry(event), event.dataTransfer!, event.ctrlKey || event.metaKey);
    },
  });
  useEffect(() => {
    if (isDragActive) return;
    setDropHint("");
    root.current
      ?.querySelectorAll<HTMLElement>("[data-drop-target]")
      .forEach((element) => delete element.dataset.dropTarget);
  }, [isDragActive]);

  const context: ExplorerContextValue = {
    conversationId,
    base,
    entryBase,
    writable,
    selected,
    selectionMode,
    focused,
    registerTree,
    openMenu,
    select,
    setFocused,
    startDrag,
    drop,
    download,
    newItem: (directory, parent) =>
      openDialog(directory ? "new-folder" : "new-file", [], parent ?? base),
    search,
    collapse: () => tree.current.collapse?.(),
    reveal: () => {
      if (viewer?.activeFilePath) {
        if (onRevealFile) onRevealFile(viewer.activeFilePath);
        else tree.current.reveal?.(viewer.activeFilePath);
      }
    },
    menu,
    toolbarMenu,
    chooseUpload,
    busy,
    isDragActive,
  };

  const applyDialog = async () => {
    if (!dialog) return;
    if (dialog.kind === "trash")
      await operation({
        operation: "trash",
        path: base,
        paths: distinctRoots(dialog.entries).map((entry) => entry.path),
      });
    else if (dialog.kind === "new-file" || dialog.kind === "new-folder") {
      if (!value.trim() || value.includes("/") || value === "." || value === "..")
        throw new Error("Enter a single file or folder name.");
      const path = childPath(dialog.parent, value);
      await operation({ operation: dialog.kind === "new-folder" ? "mkdir" : "create_file", path });
    } else {
      if (!value.trim() && dialog.kind !== "move") throw new Error("Enter a destination.");
      if (dialog.kind !== "move" && (value.includes("/") || value === "." || value === ".."))
        throw new Error("Enter a single name; use Move to for another folder.");
      await operation({
        operation: dialog.kind === "duplicate" ? "copy" : "move",
        overwrite,
        entries: distinctRoots(dialog.entries).map((entry) => ({
          source: entry.path,
          destination:
            dialog.kind === "move"
              ? childPath(value === "/" ? "/" : value.replace(/\/$/, ""), basename(entry.path))
              : childPath(parentPath(entry.path), value),
        })),
      });
    }
    setDialog(null);
  };

  const startUpload = async () => {
    if (!upload || (!conversationId && !workspace)) return;
    startExplorerUpload(conversationId ?? "", upload, overwrite, refresh, workspace ?? undefined);
    setUpload(null);
  };

  const dialogTitle = dialog
    ? {
        "new-file": "New file",
        "new-folder": "New folder",
        rename: "Rename",
        move: "Move to folder",
        duplicate: "Duplicate",
        trash: "Move to trash",
      }[dialog.kind]
    : "File operation";
  const onKeyDown: HTMLAttributes<HTMLDivElement>["onKeyDown"] = (event) => {
    if (
      (event.target as HTMLElement).closest(
        "input,textarea,[contenteditable=true],[role=dialog],[role=menu]",
      )
    )
      return;
    const active = (event.target as HTMLElement).closest<HTMLElement>("[data-explorer-entry]");
    const path = active?.dataset.explorerEntry ?? focused;
    const entry = tree.current.entries.find((item) => item.path === path);
    const cmd = event.metaKey || event.ctrlKey;
    const entries = entry ? picked(entry) : [...selected.values()];
    if (cmd && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Map(tree.current.entries.map((item) => [item.path, item])));
    } else if (cmd && ["c", "x", "v"].includes(event.key.toLowerCase())) {
      if (!writable && event.key.toLowerCase() !== "c") return;
      event.preventDefault();
      void run(() =>
        event.key.toLowerCase() === "v"
          ? paste(entry ? destinationFor(entry) : base)
          : setClipboard(entries, event.key.toLowerCase() === "x"),
      );
    } else if (event.key === "F2" && writable && entry) {
      event.preventDefault();
      openDialog("rename", [entry]);
    } else if (
      (event.key === "Delete" || event.key === "Backspace") &&
      writable &&
      entries.length
    ) {
      event.preventDefault();
      openDialog("trash", entries);
    } else if (event.key === "Escape") {
      setSelected(new Map());
      anchor.current = null;
      setSelectionMode(false);
    } else if (
      ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      const nodes = Array.from(
        root.current?.querySelectorAll<HTMLElement>("[data-explorer-entry]") ?? [],
      );
      const index = nodes.indexOf(active!);
      const next =
        event.key === "Home"
          ? nodes[0]
          : event.key === "End"
            ? nodes.at(-1)
            : nodes[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (tree.current.navigate) {
        const target = tree.current.navigate(path ?? "", event.key);
        const nextEntry =
          target === null
            ? undefined
            : tree.current.entries.find((item) => item.path === joinBrowseLocation(base, target));
        if (nextEntry) select(nextEntry, false, event.shiftKey);
      } else if (next) {
        next.focus();
        if (event.shiftKey)
          select(
            { path: next.dataset.explorerEntry!, directory: next.dataset.directory === "true" },
            false,
            true,
          );
      }
    } else if (event.key === "Enter" && active && event.target === active) {
      event.preventDefault();
      active.querySelector<HTMLButtonElement>("button")?.click();
    } else if (
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
      entry &&
      active
    ) {
      event.preventDefault();
      const box = active.getBoundingClientRect();
      openMenu(entry, box.left, box.bottom);
    }
  };

  return (
    // Selection and transfer status intentionally update every action consumer.
    // eslint-disable-next-line react/jsx-no-constructed-context-values
    <ExplorerContext.Provider value={context}>
      <div
        ref={setRoot}
        data-view-retain={localBusy || !!dialog || !!upload || !!pasteConflict || undefined}
        className="relative flex min-h-0 flex-1 flex-col"
        onKeyDown={onKeyDown}
        onClick={(event) => {
          if (
            !(event.target instanceof Element) ||
            event.target.closest(
              '[data-explorer-entry], [data-explorer-action], button, input, textarea, select, a, label, [role="menu"], [role="dialog"], [contenteditable="true"]',
            )
          )
            return;
          setSelected(new Map());
        }}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("input,[data-explorer-entry]")) return;
          event.preventDefault();
          openMenu({ path: base, directory: true }, event.clientX, event.clientY);
        }}
      >
        {children}
        {isDragActive && dropTarget && (
          <FileDropOverlay
            container={dropTarget}
            appearance="outline"
            label={dropHint || "Drop onto a folder, or here for the current folder"}
          />
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Upload files"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []).map((file) => ({
              file,
              path: file.name,
            }));
            if (files.length) {
              setUpload({ files, directories: [], destination: uploadDestination.current });
              setOverwrite(false);
            }
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={(node) => {
            folderInput.current = node;
            node?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          multiple
          hidden
          aria-label="Upload folder"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []).map((file) => ({
              file,
              path: file.webkitRelativePath || file.name,
            }));
            if (files.length) {
              setUpload({ files, directories: [], destination: uploadDestination.current });
              setOverwrite(false);
            }
            event.currentTarget.value = "";
          }}
        />
      </div>
      {point &&
        createPortal(
          <DropdownMenu open modal={false} onOpenChange={(open) => !open && setPoint(null)}>
            <DropdownMenuTrigger asChild>
              <span className="fixed" style={{ left: point.x, top: point.y }} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
              {menu(point.entry)}
            </DropdownMenuContent>
          </DropdownMenu>,
          document.body,
        )}
      <Dialog
        open={pasteConflict !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPasteConflict(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace existing files?</DialogTitle>
            <DialogDescription>
              Items already exist in {pasteConflict?.destination || "the workspace root"}. Replace
              overwrites the existing destination items.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setPasteConflict(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!pasteConflict) return;
                  await paste(pasteConflict.destination, pasteConflict.clipboard, true);
                  setPasteConflict(null);
                })
              }
            >
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {dialog?.kind === "trash"
                ? `${dialog.entries.length} item(s) will be kept in this folder’s trash until restored or removed.`
                : dialog?.kind === "move"
                  ? "Use a workspace-relative or absolute folder path. Leave the destination empty for the workspace root."
                  : "Changes apply to files on the connected host."}
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === "trash" ? (
            <ul className="max-h-48 overflow-auto text-sm">
              {dialog.entries.map((entry) => (
                <li key={entry.path}>{entry.path}</li>
              ))}
            </ul>
          ) : (
            <label className="space-y-1 text-sm">
              <span>{dialog?.kind === "move" ? "Destination folder" : "Name"}</span>
              <Input
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !busy) {
                    event.preventDefault();
                    void run(applyDialog);
                  }
                }}
              />
            </label>
          )}
          {(dialog?.kind === "move" ||
            dialog?.kind === "duplicate" ||
            dialog?.kind === "rename") && (
            <label className="flex gap-2 text-sm">
              <Checkbox
                checked={overwrite}
                onCheckedChange={(checked) => setOverwrite(checked === true)}
              />
              Replace existing destination
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void run(applyDialog)}>
              {busy ? "Working…" : dialog?.kind === "trash" ? "Move to trash" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={trash !== null}
        onOpenChange={(open) => {
          if (!open) setTrash(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore deleted files</DialogTitle>
            <DialogDescription>
              Deleted items from the current folder’s trash. Existing files will not be overwritten.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-auto">
            {trash?.length === 0 && (
              <p className="text-sm text-muted-foreground">Trash is empty.</p>
            )}
            {trash?.map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-all">{item.original_path}</span>
                <Button
                  size="sm"
                  disabled={busy || !writable}
                  onClick={() =>
                    void run(async () => {
                      await operation({ operation: "restore", path: base, ids: [item.id] });
                      await loadTrash();
                    })
                  }
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={upload !== null}
        onOpenChange={(open) => {
          if (!open) setUpload(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload {upload?.files.length} file(s)</DialogTitle>
            <DialogDescription>
              Folder structure is preserved. Files are written after each upload completes.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-sm">
            <span>Destination folder</span>
            <Input
              value={upload?.destination ?? ""}
              placeholder="Workspace root"
              onChange={(event) =>
                setUpload(
                  (previous) => previous && { ...previous, destination: event.target.value },
                )
              }
            />
          </label>
          <label className="flex gap-2 text-sm">
            <Checkbox
              checked={overwrite}
              onCheckedChange={(checked) => setOverwrite(checked === true)}
            />
            Replace existing files
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpload(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !writable} onClick={() => void run(startUpload)}>
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ExplorerContext.Provider>
  );
}

export function ExplorerToolbar({
  showAgentChanges,
  onShowAgentChangesChange,
  inline = false,
  onRefresh,
  refreshing = false,
  viewOptions,
}: {
  showAgentChanges?: boolean;
  onShowAgentChangesChange?: (show: boolean) => void;
  inline?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  viewOptions?: ReactNode;
} = {}) {
  const ctx = useContext(ExplorerContext);
  if (!ctx) return null;
  const actions = [
    {
      label: "New file",
      Icon: FilePlusIcon,
      disabled: !ctx.writable || ctx.busy,
      run: () => ctx.newItem(false),
    },
    {
      label: "New folder",
      Icon: FolderPlusIcon,
      disabled: !ctx.writable || ctx.busy,
      run: () => ctx.newItem(true),
    },
    ...(onRefresh
      ? [{ label: "Refresh files", Icon: RefreshCwIcon, disabled: refreshing, run: onRefresh }]
      : []),
    { label: "Collapse all folders", Icon: CopyMinusIcon, disabled: false, run: ctx.collapse },
  ];
  return (
    <div
      className={cn("flex shrink-0 items-center gap-[2px]", !inline && "px-2 py-1")}
      aria-label="File actions"
    >
      {actions.map(({ label, Icon, disabled, run }) => (
        <Button
          key={label}
          size="icon-sm"
          variant="ghost"
          title={label}
          aria-label={label}
          disabled={disabled}
          onClick={run}
          className={inline ? "@max-[400px]/filespanel:hidden" : undefined}
        >
          <Icon className={cn(label === "Refresh files" && refreshing && "animate-spin")} />
        </Button>
      ))}
      {ctx.selected.size > 0 && (
        <span className={cn("text-xs text-muted-foreground", inline && "sr-only")}>
          {ctx.selected.size} selected
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="More file actions">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Folder actions</DropdownMenuLabel>
          {actions.map(({ label, Icon, disabled, run }) => (
            <DropdownMenuItem key={label} disabled={disabled} onSelect={run}>
              <Icon />
              {label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />

          {!inline && onShowAgentChangesChange && (
            <>
              <DropdownMenuCheckboxItem
                checked={showAgentChanges ?? false}
                onCheckedChange={onShowAgentChangesChange}
              >
                Show agent changes
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
            </>
          )}
          {ctx.toolbarMenu(viewOptions)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Shared trailing column for tree, filename results and changed-file rows. */
export function ExplorerRowActions({
  path,
  directory = false,
  deleted = false,
  bytes = null,
  marker,
}: {
  path: string;
  directory?: boolean;
  deleted?: boolean;
  bytes?: number | null;
  conversationId?: string;
  marker?: ReactNode;
}) {
  const ctx = useContext(ExplorerContext);
  const revealBase = useContext(RevealBaseContext);
  const entry = { path: joinBrowseLocation(ctx?.entryBase ?? revealBase, path), directory };
  const restingMetaClass =
    ctx &&
    !deleted &&
    "[[data-explorer-entry]:hover_&]:opacity-0 [[data-explorer-entry]:focus-within_&]:opacity-0 [@media(hover:none)]:hidden";
  return (
    <span
      data-explorer-action
      className="flex shrink-0 items-center justify-end gap-1"
      onClick={(event) => event.stopPropagation()}
    >
      {ctx?.selectionMode && !deleted && (
        <Checkbox
          aria-label={`Select ${path}`}
          checked={ctx.selected.has(entry.path)}
          onCheckedChange={() => ctx.select(entry, true, false)}
          className="size-5"
        />
      )}
      <span
        className={cn(
          "relative flex items-center justify-end",
          ctx && !deleted && "min-h-6 min-w-6",
        )}
      >
        <span data-explorer-meta className={cn("flex items-center gap-1.5", restingMetaClass)}>
          {marker}
          {bytes !== null && !deleted && (
            <span data-file-size className={cn("text-sm text-muted-foreground", restingMetaClass)}>
              {formatBytes(bytes)}
            </span>
          )}
        </span>
        {ctx && !deleted && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="pointer-events-none absolute right-0 text-muted-foreground opacity-0 [[data-explorer-entry]:hover_&]:pointer-events-auto [[data-explorer-entry]:hover_&]:opacity-100 [[data-explorer-entry]:focus-within_&]:pointer-events-auto [[data-explorer-entry]:focus-within_&]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:opacity-100"
            aria-label={`Actions for ${path}`}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              ctx.openMenu(entry, box.left, box.bottom);
            }}
          >
            <MoreHorizontalIcon />
          </Button>
        )}
      </span>
    </span>
  );
}

export const explorerRowClass = "data-[drop-target=true]:bg-accent";
