// Modified for Triune.
import type { ReactNode } from "react";
import {
  ResourceViewIdContext,
  subscribePanelFolder,
  readPanelFolder,
  setPanelFolder,
  panelFolderKey,
  useResourceViewId,
  useResourceViewState,
} from "@/lib/panelFolder";
import {
  EyeIcon,
  EyeOffIcon,
  FilterIcon,
  MoonIcon,
  SearchIcon,
  XIcon,
  ArrowDownAZIcon,
  FileClockIcon,
  ArrowDownWideNarrowIcon,
  FileTypeIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@/lib/routing";
import { useSession } from "@/hooks/useSession";
import { isOwnerLevel } from "@/lib/permissionsApi";
import { useSessionHostOnline, useSessionRunnerOnline } from "@/hooks/RunnerHealthProvider";
import { useChatStore } from "@/store/chatStore";
import {
  PathUnreachableError,
  joinBrowseLocation,
  relativizeToWorkspace,
  useWorkspaceAllFiles,
  useWorkspaceAsleep,
  useWorkspaceEnvironment,
  useWorkspaceFileSearch,
} from "@/hooks/useWorkspaceChangedFiles";
import { useWorkspaceComparisonChanges } from "@/hooks/useWorkspaceComparisons";
import {
  DEFAULT_WORKSPACE_COMPARISON,
  isRevisionComparison,
  getWorkspaceComparison,
  setWorkspaceComparison,
  useWorkspaceComparison,
  type WorkspaceComparisonView,
} from "@/lib/workspaceComparison";
import { Button } from "@/components/ui/button";
import { TooltipButton, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkbenchWorkspace, queryIdentity } from "@/lib/workbenchWorkspace";
import { cn } from "@/lib/utils";
import { BrowseLocationBar } from "./BrowseLocationBar";
import { DiffComparisonControls } from "./DiffComparisonControls";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { type ChangedSort, FlatFileList } from "./FlatFileList";
import { FolderTree } from "./FolderTree";
import { RunnerAsleepHint } from "./RunnerAsleepHint";
import { useScrollRestore } from "./useScrollRestore";
import { ExplorerActionsProvider, ExplorerToolbar } from "./ExplorerActions";
import { setExplorerGitScope } from "@/lib/explorerGitScope";

export { readBrowseLocation } from "@/lib/panelFolder";

interface FilesPanelProps {
  revealRequest?: { path: string; token: string };
  viewId?: string;
  active?: boolean;
  hideLocation?: boolean;
  locationControls?: ReactNode;
  conversationId?: string;
  workspaceId?: string;
  /** Comparison selection owned by this Explorer surface. */
  view?: WorkspaceComparisonView;
  onFileSelect: (path: string) => void;
  /**
   * Which scope this panel renders: false = full folder tree, true =
   * changed-files-only flat list. Fixed by the caller (the Files vs Changes
   * rail tab / mobile drawer) rather than switched inside the panel.
   */
  flatView: boolean;
  /**
   * Whether hidden files (dot-prefixed paths) are visible. Lifted to
   * the parent so the state survives inline→drawer transitions.
   */
  showHidden: boolean;
  onShowHiddenChange: (showHidden: boolean) => void;
  /**
   * Lifted changed-files sort order. Lifted to AppShell so it survives
   * inline→drawer transitions and stays in sync with the FileViewer's
   * prev/next navigation order.
   */
  sort: ChangedSort;
  onSortChange: (sort: ChangedSort) => void;
  /**
   * When provided, the panel renders an X close button in the header and
   * fills its parent's height — dropping the rounded card chrome so it can
   * serve as the entire content of a full-screen drawer.
   */
  onClose?: () => void;
  /**
   * Frameless mode: drops the rounded card chrome and fills the parent
   * container's height (like the `onClose` drawer) — but without a close
   * button. Used by the inline right panel where the panel is embedded in a
   * split layout rather than a drawer.
   */
  frameless?: boolean;
}

const SORT_OPTIONS: { value: ChangedSort; label: string; Icon: typeof ArrowDownAZIcon }[] = [
  { value: "alpha", label: "Filename", Icon: ArrowDownAZIcon },
  { value: "recent", label: "Last edited", Icon: FileClockIcon },
  { value: "size", label: "Size", Icon: ArrowDownWideNarrowIcon },
  { value: "type", label: "Type", Icon: FileTypeIcon },
];

// ---------------------------------------------------------------------------
// SearchFilterInput — labeled glob input for "files to include" / "exclude"
// ---------------------------------------------------------------------------

function SearchFilterInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <input
        aria-label={label}
        className="w-full rounded border border-border bg-transparent px-2 py-1 font-mono text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="text"
        value={value}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Browse location per conversation, surviving unmount/remount within a JS
 * session. Opening a file swaps this panel for the FileViewer (see
 * WorkspacePanel's content slot), which unmounts it — with plain state,
 * closing the viewer snapped the tree back to the workspace root instead of
 * the directory the file was opened from. Same pattern as FolderTree's
 * expandedPathsCache. Keyed by conversation, so a session switch still lands
 * on that session's own last location (or its root), never another's.
 */
const ROOT_DIRECTORIES = [""];
const visitedDirectoriesCache = new Map<string, string[]>();
const directoryListeners = new Set<() => void>();

function subscribeDirectories(onChange: () => void) {
  directoryListeners.add(onChange);
  return () => directoryListeners.delete(onChange);
}

/**
 * Right-side Files card. Always visible on desktop.
 *
 * - Flat view: changed files only (registry-backed, any depth).
 * - Tree view: all on-disk files in the workspace root, expandable folders.
 *
 * Uploaded/attached files are rendered inline in the message thread and are
 * intentionally not listed here.
 */
export function FilesPanel(props: FilesPanelProps) {
  const viewId = useResourceViewId(props.viewId);
  return (
    <ResourceViewIdContext.Provider value={viewId}>
      <FilesPanelContent {...props} viewId={viewId} />
    </ResourceViewIdContext.Provider>
  );
}

function FilesPanelContent({
  revealRequest,
  conversationId: sessionId,
  workspaceId: explicitWorkspaceId,
  viewId: explicitViewId,
  hideLocation = false,
  locationControls,
  active = true,
  view: requestedView,
  onFileSelect,
  flatView,
  showHidden,
  onShowHiddenChange,
  sort: changedSort,
  onSortChange,
  onClose,
  frameless,
}: FilesPanelProps) {
  const { conversationId: routeId } = useParams<{ conversationId: string }>();
  const workspace = useWorkbenchWorkspace();
  const viewId = useResourceViewId(explicitViewId);
  const workspaceId = explicitWorkspaceId ?? workspace?.id;
  const conversationId = sessionId ?? (viewId ? undefined : routeId);
  const browseOwner = panelFolderKey(workspaceId ?? conversationId, viewId);
  const sourceChatId = workspace ? (workspace.chatSessionId ?? undefined) : conversationId;
  const resourceIdentity = queryIdentity(workspaceId, conversationId);
  // The runner went offline (e.g. its host restarted): `sessionStatus`
  // is "failed", set by `_on_runner_disconnect` server-side when the
  // runner's tunnel drops (and also client-side in chatStore when the
  // SSE stream itself dies). Either way the session can't be reached and
  // a message reconnects it. A brand-new session whose runner just hasn't
  // started is never "failed", so this distinguishes "asleep, send a
  // message to reconnect" from a fresh session that should show the
  // normal empty state — a real liveness signal, not an inference from
  // chat history.
  const runnerWentOffline = useChatStore(
    (s) => s.conversationId === conversationId && s.sessionStatus === "failed",
  );
  const sandboxAsleep = useWorkspaceAsleep(conversationId);
  // The runner is offline but the host still holds the workspace on disk,
  // so the server serves the panel by reading the workspace over the host
  // tunnel. Show a passive "served from host" badge — the panel keeps
  // working and no message/agent wake-up is triggered. Only when the host
  // is also down (or the session isn't host-bound) do the file queries
  // surface RunnerOfflineError and fall back to the reconnect hint.
  const runnerOnline = useSessionRunnerOnline(conversationId);
  const hostOnline = useSessionHostOnline(conversationId);
  const servedFromHost = !workspace && runnerOnline === false && hostOnline === true;
  const [changedSearch, setChangedSearch] = useResourceViewState(
    browseOwner,
    viewId,
    "changedSearch",
    "",
  );
  const [treeSearch, setTreeSearch] = useResourceViewState(browseOwner, viewId, "treeSearch", "");
  const [debouncedTreeSearch, setDebouncedTreeSearch] = useState("");
  // "files to include" / "files to exclude" glob filters (VSCode-style),
  // revealed by the filters toggle in the Explore search bar.
  const [treeInclude, setTreeInclude] = useResourceViewState(
    browseOwner,
    viewId,
    "treeInclude",
    "",
  );
  const [debouncedTreeInclude, setDebouncedTreeInclude] = useState("");
  const [treeExclude, setTreeExclude] = useResourceViewState(
    browseOwner,
    viewId,
    "treeExclude",
    "",
  );
  const [debouncedTreeExclude, setDebouncedTreeExclude] = useState("");
  const [showSearchFilters, setShowSearchFilters] = useResourceViewState(
    browseOwner,
    viewId,
    "showSearchFilters",
    false,
  );
  const queryClient = useQueryClient();
  const refreshInFlight = useRef(false);
  const [refreshingFiles, setRefreshingFiles] = useState(false);
  // The drawer (onClose) adds an X close button to the header. Both the drawer
  // and the inline rail (frameless) fill their parent's height and drop the
  // rounded card chrome; only the standalone card caps content at max-h.
  const isDrawer = onClose !== undefined;
  const fillHeight = isDrawer || frameless === true;
  const view = requestedView ?? (flatView ? "changes" : "files");
  const { comparison, setComparison } = useWorkspaceComparison({
    workspaceId,
    conversationId: sourceChatId,
    view,
    viewId,
  });
  const envQuery = useWorkspaceEnvironment(conversationId, {
    enabled: active,
  });
  const workspaceRoot = envQuery.data?.root ?? null;
  // The picker browses the host's filesystem, the same source the new-session
  // workspace chip uses.
  const { session } = useSession(conversationId);
  const permissionLevel = workspace
    ? (workspace.permission_level ?? null)
    : (session?.permissionLevel ?? null);
  const hostId = workspace ? workspace.host_id : (session?.hostId ?? null);
  // Absolute path currently browsed. Null tracks the workspace root. Seeded
  // from the per-conversation cache so the location survives the panel
  // unmounting while a file is open in the viewer.
  const browseLocation = useSyncExternalStore(
    subscribePanelFolder,
    () => readPanelFolder(browseOwner),
    () => null,
  );
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [revealToken, setRevealToken] = useState(0);
  const workingDir = browseLocation ?? workspaceRoot;
  // The wire form: "" means the workspace root (the historical relative
  // contract). A location INSIDE the workspace is sent relative to it, and
  // only a genuinely outside one is sent absolute. That distinction is not
  // cosmetic: the server gates absolute paths at owner level, so sending an
  // absolute path for a subfolder would 403 every collaborator browsing the
  // workspace they can already read.
  const locationParam = relativizeToWorkspace(browseLocation, workspaceRoot);
  // Retain discovered directories across Files/Changes mounts.
  // Refresh only these bounded scopes.
  const directoryKey = JSON.stringify([browseOwner, workspaceRoot, locationParam]);
  const directories = useSyncExternalStore(
    subscribeDirectories,
    () => visitedDirectoriesCache.get(directoryKey) ?? ROOT_DIRECTORIES,
    () => ROOT_DIRECTORIES,
  );
  const onDirectoriesChange = useCallback(
    (expanded: string[]) => {
      const previous = visitedDirectoriesCache.get(directoryKey) ?? ROOT_DIRECTORIES;
      const next = Array.from(new Set([...previous, ...expanded]))
        .sort()
        .slice(0, 128);
      if (next.length === previous.length && next.every((path, i) => path === previous[i])) return;
      visitedDirectoriesCache.set(directoryKey, next);
      for (const listener of directoryListeners) listener();
    },
    [directoryKey],
  );
  const gitDirectories = useMemo(
    () => directories.map((dir) => joinBrowseLocation(locationParam, dir)),
    [directories, locationParam],
  );
  useEffect(() => {
    setExplorerGitScope(
      { workspaceId, conversationId, viewId },
      { path: locationParam, directories: gitDirectories },
    );
  }, [workspaceId, conversationId, viewId, locationParam, gitDirectories]);
  const comparisonQuery = useWorkspaceComparisonChanges(conversationId, {
    workspaceId,
    view,
    viewId,
    ...(workspace && !sourceChatId ? { agentEnabled: false } : {}),
    path: locationParam,
    directories: gitDirectories,
    enabled: active,
  });
  const changedFiles = useMemo(
    () =>
      (comparisonQuery.data?.data ?? [])
        .map((file) => ({ ...file, path: relativizeToWorkspace(file.path, workspaceRoot) }))
        .filter((file) => {
          if (!locationParam) return !file.path.startsWith("/");
          const scopedPath =
            locationParam.startsWith("/") && !file.path.startsWith("/") && workspaceRoot
              ? joinBrowseLocation(workspaceRoot, file.path)
              : file.path;
          return (
            scopedPath === locationParam ||
            scopedPath.startsWith(`${locationParam.replace(/\/$/, "")}/`)
          );
        }),
    [comparisonQuery.data, workspaceRoot, locationParam],
  );
  const changedQuery = {
    ...comparisonQuery,
    data:
      comparisonQuery.data === undefined
        ? undefined
        : { ...comparisonQuery.data, data: changedFiles },
  };

  const navigateTo = useCallback(
    (absolutePath: string) => {
      if (absolutePath === workingDir) return;
      // Revision hashes belong to the selected repository and cannot follow a new folder.
      for (const comparisonView of ["files", "changes"] as const) {
        const scope = { workspaceId, conversationId, viewId, view: comparisonView };
        if (isRevisionComparison(getWorkspaceComparison(scope)))
          setWorkspaceComparison(scope, DEFAULT_WORKSPACE_COMPARISON);
      }
      setBrowseError(null);
      const next = absolutePath === workspaceRoot ? null : absolutePath;
      if (browseOwner) setPanelFolder(browseOwner, next);
      window.dispatchEvent(
        new CustomEvent("omnigent:browse-location-changed", {
          detail: {
            conversationId,
            ...(workspaceId ? { workspaceId } : {}),
            ...(viewId ? { viewId } : {}),
            location: relativizeToWorkspace(next, workspaceRoot),
          },
        }),
      );
    },
    [workspaceRoot, workspaceId, conversationId, viewId, browseOwner, workingDir],
  );

  const navigateToChild = useCallback(
    (relativePath: string) => {
      if (!workingDir) return;
      navigateTo(`${workingDir.replace(/\/$/, "")}/${relativePath}`);
    },
    [workingDir, navigateTo],
  );

  /**
   * Open a file the TREE named. Tree paths are relative to the browsed
   * location, so the location is re-attached before handing the file to the
   * viewer. For an in-workspace location that yields a workspace-relative
   * path; for a location OUTSIDE the workspace it yields the file's absolute
   * path, which the viewer fetches host-absolutely (see `fetchFileContent`).
   * Without this a file opened while browsing an absolute location like
   * `/tmp` would be looked up by its bare name under the workspace root and
   * 404.
   */
  const openTreeFile = useCallback(
    (path: string) => {
      onFileSelect(joinBrowseLocation(locationParam, path));
    },
    [onFileSelect, locationParam],
  );

  const allFilesQuery = useWorkspaceAllFiles(
    conversationId,
    { enabled: !flatView && active },
    locationParam,
  );
  // A refused location must say so on the bar. Rendering an empty tree instead
  // would read as "this directory is empty", which is a different fact.
  const unreachable =
    allFilesQuery.error instanceof PathUnreachableError ? allFilesQuery.error : null;
  const locationError =
    browseError ??
    (unreachable
      ? unreachable.reachableRoots.length > 0
        ? `${unreachable.message}. Reachable: ${unreachable.reachableRoots.join(", ")}`
        : unreachable.message
      : null);

  useEffect(() => {
    if (!flatView) setChangedSearch("");
    if (flatView) {
      setTreeSearch("");
      setDebouncedTreeSearch("");
      setTreeInclude("");
      setDebouncedTreeInclude("");
      setTreeExclude("");
      setDebouncedTreeExclude("");
    }
  }, [flatView, setChangedSearch, setTreeSearch, setTreeInclude, setTreeExclude]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedTreeSearch(treeSearch);
      setDebouncedTreeInclude(treeInclude);
      setDebouncedTreeExclude(treeExclude);
    }, 300);
    return () => clearTimeout(timer);
  }, [treeSearch, treeInclude, treeExclude]);

  // Exit search when a folder is revealed from the results. Clears BOTH the raw
  // and debounced queries: FolderTree renders search mode off the debounced
  // value, so clearing only `treeSearch` would leave the flat results list up
  // for the ~300ms debounce window — during which the tree's reveal scroll
  // fires against rows that aren't mounted yet and never re-fires. Clearing the
  // debounced value too drops back to the tree synchronously so the scroll lands.
  const exitTreeSearch = useCallback(() => {
    setTreeSearch("");
    setDebouncedTreeSearch("");
  }, [setTreeSearch]);

  // Only fire search queries on the Explore tab. The include/exclude globs
  // narrow an active text query; globs alone do not search.
  const treeSearchQuery = useWorkspaceFileSearch(
    conversationId,
    debouncedTreeSearch,
    debouncedTreeInclude,
    debouncedTreeExclude,
    {
      enabled: active && !flatView && debouncedTreeSearch.trim().length > 0,
    },
    locationParam,
  );
  useEffect(() => {
    if (!debouncedTreeSearch || treeSearchQuery.isPlaceholderData) return;
    onDirectoriesChange(
      (treeSearchQuery.data?.files ?? []).map((file) =>
        file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "",
      ),
    );
  }, [
    debouncedTreeSearch,
    treeSearchQuery.data,
    treeSearchQuery.isPlaceholderData,
    onDirectoriesChange,
  ]);
  // Highlight the filters toggle when include/exclude carry a value.
  const treeFiltersActive = treeInclude.trim().length > 0 || treeExclude.trim().length > 0;

  const refreshFiles = useCallback(
    async (background = false) => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      if (!background) setRefreshingFiles(true);
      try {
        const changeRefreshes = [comparisonQuery.refetch()];
        const refreshes = flatView
          ? changeRefreshes
          : [
              allFilesQuery.refetch(),
              ...changeRefreshes,
              queryClient.invalidateQueries({
                predicate: ({ queryKey }) =>
                  queryKey[0] === "workspace-dir" &&
                  queryKey[1] === resourceIdentity &&
                  queryKey[3] === locationParam,
              }),
              ...(debouncedTreeSearch.trim() ? [treeSearchQuery.refetch()] : []),
            ];
        await Promise.all(refreshes);
      } finally {
        refreshInFlight.current = false;
        setRefreshingFiles(false);
      }
    },
    [
      allFilesQuery,
      comparisonQuery,
      debouncedTreeSearch,
      flatView,
      queryClient,
      resourceIdentity,
      locationParam,
      treeSearchQuery,
    ],
  );

  // Persist/restore the list's scroll position across conversation and view
  // switches. Keyed per conversation + view (Changed vs All) since the two
  // lists have independent heights. Readiness is data presence rather than
  // `isLoading` — the files queries are disabled (not loading) until the
  // environment query resolves.
  const scrollRef = useRef<HTMLElement>(null);
  const scrollKey = browseOwner ? `files:${browseOwner}:${flatView ? "changed" : "all"}` : null;
  const dataReady = flatView ? changedQuery.data !== undefined : allFilesQuery.data !== undefined;
  const handleScroll = useScrollRestore(scrollRef, scrollKey, dataReady, true, active);
  // An idle-stopped managed sandbox is asleep, not failed: its status stays
  // idle, and with neither a runner nor a host to read the workspace from, the
  // lists can't load. Say so rather than "No files in workspace"; a list
  // cached before it slept still renders.
  const showAsleepHint = sandboxAsleep && !dataReady;

  // The host may change files while its session runner sleeps. Refresh only
  // the visible panel and expanded directories, never a recursive home scan.
  const liveRefresh = useRef(refreshFiles);
  liveRefresh.current = refreshFiles;
  useEffect(() => {
    if (!active) return;
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void liveRefresh.current(true);
    };
    const timer = setInterval(refreshVisible, 10_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [active, conversationId, locationParam]);

  const hiddenFilesToggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
          aria-pressed={showHidden}
          onClick={() => onShowHiddenChange(!showHidden)}
        >
          {showHidden ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{showHidden ? "Hide hidden files" : "Show hidden files"}</TooltipContent>
    </Tooltip>
  );

  const revealFileInTree = useCallback(
    (path: string) => {
      exitTreeSearch();
      const absolute = path.startsWith("/") ? path : joinBrowseLocation(workspaceRoot ?? "", path);
      if (workingDir && !absolute.startsWith(`${workingDir.replace(/\/$/, "")}/`)) {
        navigateTo(absolute.slice(0, absolute.lastIndexOf("/")) || "/");
      }
      if (path.split("/").some((part) => part.startsWith("."))) onShowHiddenChange(true);
      setRevealPath(relativizeToWorkspace(path, workspaceRoot));
      setRevealToken((token) => token + 1);
    },
    [exitTreeSearch, workspaceRoot, workingDir, navigateTo, onShowHiddenChange],
  );
  const lastReveal = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !workspaceRoot || !revealRequest || lastReveal.current === revealRequest.token)
      return;
    lastReveal.current = revealRequest.token;
    revealFileInTree(revealRequest.path);
  }, [active, workspaceRoot, revealRequest, revealFileInTree]);

  return (
    <ExplorerActionsProvider
      key={`${browseOwner}:${flatView}:${locationParam}`}
      conversationId={conversationId}
      base={locationParam}
      entryBase={flatView ? "" : locationParam}
      workspaceRoot={workspaceRoot}
      hostId={hostId}
      writable={
        (permissionLevel == null || permissionLevel >= 2) &&
        (!locationParam.startsWith("/") || isOwnerLevel(permissionLevel))
      }
      onRefresh={refreshFiles}
      onRevealFile={revealFileInTree}
    >
      <div
        data-context-search-region="explorer"
        className={cn(
          "@container/filespanel overflow-hidden bg-card",
          fillHeight ? "flex h-full min-h-0 flex-col" : "flex min-h-0 flex-col",
        )}
      >
        {/* Shared folder scope and actions for Files and Changes. */}
        <div className="workspace-control-header flex items-center gap-[2px] border-b border-border px-2">
          {locationControls ??
            (!hideLocation && workingDir && workspaceRoot && (
              <BrowseLocationBar
                current={workingDir}
                workspace={workspaceRoot}
                hostId={hostId}
                canBrowseOutside={isOwnerLevel(permissionLevel)}
                reach={envQuery.data?.reachable ?? null}
                onNavigate={navigateTo}
                error={locationError}
              />
            ))}
          <div className="ml-auto flex items-center gap-[2px]">
            <DiffComparisonControls
              value={comparison}
              sessionId={sourceChatId}
              scopePath={locationParam}
              onChange={setComparison}
              repositoryRoot={comparisonQuery.data?.root_is_repository ?? false}
              turns={comparisonQuery.data?.turns}
              compact
            />
            <ExplorerToolbar
              inline
              onRefresh={() => void refreshFiles()}
              refreshing={refreshingFiles}
              viewOptions={
                <>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <ArrowDownAZIcon />
                      Sort by
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={changedSort}
                        onValueChange={(value) => onSortChange(value as ChangedSort)}
                      >
                        {SORT_OPTIONS.map(({ value, label, Icon }) => (
                          <DropdownMenuRadioItem key={value} value={value}>
                            <Icon />
                            {label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuCheckboxItem
                    checked={showHidden}
                    onCheckedChange={onShowHiddenChange}
                  >
                    {showHidden ? <EyeOffIcon /> : <EyeIcon />}Show hidden files
                  </DropdownMenuCheckboxItem>
                  {!flatView && (
                    <DropdownMenuItem onSelect={() => setShowSearchFilters((value) => !value)}>
                      <FilterIcon />
                      {showSearchFilters
                        ? "Hide filename filters"
                        : "Filename include/exclude filters"}
                      {treeFiltersActive ? " •" : ""}
                    </DropdownMenuItem>
                  )}
                </>
              }
            />
            {onClose && (
              <TooltipButton
                type="button"
                aria-label="Close files"
                className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={onClose}
              >
                <XIcon className="size-4" />
              </TooltipButton>
            )}
          </div>
        </div>
        {(flatView ? changedQuery : allFilesQuery).isError && dataReady && (
          <p role="alert" className="px-3 py-1 text-xs text-destructive">
            Could not refresh files. Showing the last loaded listing.
          </p>
        )}
        {!flatView && comparisonQuery.isError && (
          <p className="px-2 py-1 text-sm text-destructive" role="status">
            Comparison unavailable:{" "}
            {comparisonQuery.error instanceof Error
              ? comparisonQuery.error.message
              : String(comparisonQuery.error)}
          </p>
        )}
        {comparisonQuery.data?.warning && (
          <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
            {comparisonQuery.data.warning}
          </p>
        )}
        {servedFromHost && (
          <p
            role="status"
            data-testid="files-host-served-badge"
            className="flex shrink-0 items-center gap-1 px-2 py-1 text-xs text-muted-foreground"
            title="Agent is asleep. Send a message to wake it."
          >
            <MoonIcon className="size-3 shrink-0" />
            Files served by host
          </p>
        )}
        {/* Search toolbar — the Changed | All scope switch leads, then the
              search field, then the per-view trailing control (Sort for the
              changed list, glob filters for the tree). Lives outside the
              scroll container so negative margins aren't clipped. */}
        {flatView && (
          <div
            className="shrink-0 flex items-center gap-2 px-2 py-2 @max-[400px]/filespanel:flex-col @max-[400px]/filespanel:items-stretch"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex min-w-0 flex-1 items-center gap-[2px]">
              <div className="flex min-w-0 flex-1 items-center gap-[6px] rounded-lg border border-border px-[10px] py-[4px] transition-colors focus-within:border-border-strong">
                <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                <input
                  aria-label="Search changed files"
                  className="w-0 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  onChange={(event) => setChangedSearch(event.target.value)}
                  placeholder="Find changed files by name"
                  type="search"
                  value={changedSearch}
                />
              </div>
              {hiddenFilesToggle}
            </div>
          </div>
        )}
        {!flatView && (
          <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-2 py-2 @max-[400px]/filespanel:flex-col @max-[400px]/filespanel:items-stretch">
              <div className="flex min-w-0 flex-1 items-center gap-[2px]">
                <div className="flex min-w-0 flex-1 items-center gap-[6px] rounded-lg border border-border px-[10px] py-[4px] transition-colors focus-within:border-border-strong">
                  <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    aria-label="Search all files"
                    className="w-0 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    onChange={(event) => setTreeSearch(event.target.value)}
                    placeholder="Find files by name"
                    type="search"
                    value={treeSearch}
                  />
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Filename include/exclude filters"
                      aria-expanded={showSearchFilters}
                      aria-pressed={treeFiltersActive}
                      className={cn(treeFiltersActive && "bg-muted text-foreground")}
                      onClick={() => setShowSearchFilters((value) => !value)}
                    >
                      <FilterIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Filename include/exclude filters</TooltipContent>
                </Tooltip>
                {hiddenFilesToggle}
              </div>
            </div>
            {showSearchFilters && (
              <div className="flex flex-col gap-1.5 border-border border-t px-3 py-2">
                <SearchFilterInput
                  label="files to include"
                  placeholder="e.g. *.ts, src/**"
                  value={treeInclude}
                  onChange={setTreeInclude}
                />
                <SearchFilterInput
                  label="files to exclude"
                  placeholder="e.g. **/node_modules, *.test.ts"
                  value={treeExclude}
                  onChange={setTreeExclude}
                />
              </div>
            )}
          </div>
        )}
        <section
          role="tree"
          aria-label={flatView ? "Changed files" : "Workspace files"}
          aria-multiselectable="true"
          ref={scrollRef}
          className={cn(
            "overflow-y-auto px-2 pb-2",
            flatView ? "pt-1" : "pt-0",
            fillHeight ? "min-h-0 flex-1" : "max-h-72",
          )}
          onScroll={handleScroll}
        >
          {showAsleepHint && <RunnerAsleepHint sandboxOffline />}
          {!showAsleepHint && flatView && (
            <FlatFileList
              files={changedQuery.data?.data}
              repositories={comparisonQuery.data?.repositories}
              workspaceRoot={workspaceRoot}
              isLoading={changedQuery.isLoading}
              isError={changedQuery.isError}
              error={changedQuery.error}
              onFileSelect={onFileSelect}
              showHidden={showHidden}
              onShowHidden={() => onShowHiddenChange(true)}
              searchQuery={changedSearch}
              sort={changedSort}
              conversationId={conversationId}
              runnerWentOffline={runnerWentOffline}
              emptyMessage={
                comparison.source === "git"
                  ? "No Git changes in the selected folder"
                  : "No changes in this comparison for the selected folder"
              }
            />
          )}
          {!showAsleepHint && !flatView && (
            <FolderTree
              active={active}
              viewId={viewId}
              files={allFilesQuery.data?.data}
              isLoading={allFilesQuery.isLoading}
              isError={allFilesQuery.isError}
              error={allFilesQuery.error}
              onFileSelect={openTreeFile}
              conversationId={conversationId}
              showHidden={showHidden}
              onShowHidden={() => onShowHiddenChange(true)}
              changedFiles={changedFiles}
              includeMissingChanges={false}
              sort={changedSort}
              runnerWentOffline={runnerWentOffline}
              searchQuery={debouncedTreeSearch}
              // Suppress keep-previous placeholder data: while a new query is in
              // flight React Query returns the PRIOR term's results (isPlaceholderData),
              // which would otherwise render as if they matched the new term. Drop
              // them so the tree shows "Searching…" until the real results land.
              searchResults={
                treeSearchQuery.isPlaceholderData ? undefined : treeSearchQuery.data?.files
              }
              searchTruncated={
                !treeSearchQuery.isPlaceholderData && (treeSearchQuery.data?.truncated ?? false)
              }
              isSearching={treeSearchQuery.isFetching}
              isSearchError={treeSearchQuery.isError}
              searchError={treeSearchQuery.error instanceof Error ? treeSearchQuery.error : null}
              browseLocation={locationParam}
              workspaceRoot={workspaceRoot}
              onDirectoriesChange={onDirectoriesChange}
              onNavigateDir={navigateToChild}
              onExitSearch={exitTreeSearch}
              scrollParentRef={scrollRef}
              revealPath={revealPath}
              revealToken={revealToken}
            />
          )}
        </section>
      </div>
    </ExplorerActionsProvider>
  );
}
