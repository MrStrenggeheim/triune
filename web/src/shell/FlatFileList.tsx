// Modified for Triune.
import { ContentSkeleton } from "@/components/ui/loading";
import {
  relativizeToWorkspace,
  RunnerOfflineError,
  type WorkspaceChangedFile,
} from "@/hooks/useWorkspaceChangedFiles";
import { RunnerAsleepHint } from "./RunnerAsleepHint";
import { cn } from "@/lib/utils";
import { TooltipButton, TooltipProvider } from "@/components/ui/tooltip";
import { ROW_META_SLOT_CLASS, statusDescription } from "./fileStatusUtils";
import { useRevealMenu } from "./RevealInFileManager";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon";
import { FileStatusMarker } from "./FileStatusMarker";
import {
  ExplorerRowActions,
  explorerRowClass,
  useExplorerRow,
  useExplorerTree,
} from "./ExplorerActions";
import { useMemo } from "react";
import { isExplorerInternalPath } from "@/lib/explorerOperations";

export type { ChangedSort } from "@/lib/changedSort";
import type { ChangedSort } from "@/lib/changedSort";

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Minimal file shape the comparator needs. Both `WorkspaceChangedFile`
 * (Changed list) and `WorkspaceFile` (All tree) satisfy it, so the two views
 * order files identically for a given sort.
 */
export interface SortableFile {
  name: string;
  path: string;
  bytes: number | null;
  modified_at: number | null;
}

export function compareChangedFiles(sort: ChangedSort) {
  return (a: SortableFile, b: SortableFile): number => {
    if (sort === "recent") {
      const am = a.modified_at;
      const bm = b.modified_at;
      if (am === null && bm === null) return a.path.localeCompare(b.path);
      if (am === null) return 1;
      if (bm === null) return -1;
      if (am !== bm) return bm - am;
      return a.path.localeCompare(b.path);
    }
    if (sort === "size") {
      const ab = a.bytes;
      const bb = b.bytes;
      if (ab === null && bb === null) return a.path.localeCompare(b.path);
      if (ab === null) return 1;
      if (bb === null) return -1;
      if (ab !== bb) return bb - ab;
      return a.path.localeCompare(b.path);
    }
    if (sort === "type") {
      const ae = fileExtension(a.name);
      const be = fileExtension(b.name);
      if (ae !== be) return ae.localeCompare(be);
      return a.path.localeCompare(b.path);
    }
    return a.path.localeCompare(b.path);
  };
}

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function FileListItem({
  file,
  isDeleted,
  onFileSelect,
  conversationId,
}: {
  file: WorkspaceChangedFile;
  isDeleted: boolean;
  onFileSelect: (path: string) => void;
  conversationId: string | undefined;
}) {
  const reveal = useRevealMenu(isDeleted ? null : file.path);
  const explorer = useExplorerRow(file.path, false, isDeleted);
  const slash = file.path.lastIndexOf("/");
  const dir = slash > 0 ? file.path.slice(0, slash) : "";

  return (
    <li>
      <div
        {...explorer.props}
        onContextMenu={explorer.props.onContextMenu ?? reveal.onContextMenu}
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 pr-1 pl-2",
          isDeleted ? "opacity-50" : "hover:bg-muted",
          explorerRowClass,
          (explorer.selected || explorer.active) && "bg-accent",
        )}
      >
        <TooltipButton
          type="button"
          className={cn("flex min-w-0 flex-1 items-baseline gap-1.5 text-left", "cursor-pointer")}
          onClick={() => onFileSelect(file.path)}
          tooltip={`Open ${file.name}`}
          tooltipDescription={statusDescription(file.path, file.status)}
        >
          <WorkspaceFileIcon path={file.path} className="self-center" />
          <span className={cn("truncate text-ui", isDeleted && "line-through")}>{file.name}</span>
          {dir && <span className="truncate text-muted-foreground text-sm">{dir}</span>}
        </TooltipButton>
        {/* Fixed-width and always rendered: a variable diffstat ("+7 −1" vs
            "+1204 −318") would otherwise shift the copy button and status
            letter to a different x on every row. */}
        <span className={cn("flex shrink-0 items-center justify-end", ROW_META_SLOT_CLASS)}>
          {((file.lines_added ?? 0) !== 0 || (file.lines_removed ?? 0) !== 0) && (
            <span
              className="font-mono text-[10px]"
              aria-label={[
                file.lines_added !== null && `${file.lines_added} lines added`,
                file.lines_removed !== null && `${file.lines_removed} removed`,
              ]
                .filter(Boolean)
                .join(", ")}
            >
              {file.lines_added !== null && (
                <span className="text-green-600 dark:text-green-400">+{file.lines_added}</span>
              )}
              {file.lines_added !== null && file.lines_removed !== null && " "}
              {file.lines_removed !== null && (
                <span className="text-destructive">&minus;{file.lines_removed}</span>
              )}
            </span>
          )}
        </span>
        <ExplorerRowActions
          path={file.path}
          deleted={isDeleted}
          bytes={file.bytes}
          marker={<FileStatusMarker status={file.status} />}
          conversationId={conversationId}
        />
        {reveal.menu}
      </div>
    </li>
  );
}

const NO_REPOSITORIES: string[] = [];

type RepositoryChangedFile = WorkspaceChangedFile & { repository?: string };

export function FlatFileList({
  files,
  isLoading,
  isError,
  error,
  onFileSelect,
  showHidden,
  onShowHidden,
  searchQuery,
  sort,
  conversationId,
  runnerWentOffline = false,
  emptyMessage = "No workspace changes yet",
  repositories = NO_REPOSITORIES,
  workspaceRoot = null,
}: {
  files: RepositoryChangedFile[] | undefined;
  repositories?: string[];
  workspaceRoot?: string | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onFileSelect: (path: string) => void;
  showHidden: boolean;
  onShowHidden: () => void;
  searchQuery: string;
  sort: ChangedSort;
  /** Session ID used to fetch file content for downloads. */
  conversationId: string | undefined;
  /**
   * The runner went offline after being connected (session status
   * "failed", e.g. host restarted) — show the reconnect hint. When the
   * session simply hasn't started yet (a new session also 503s) this is
   * false and we fall through to the normal empty state instead.
   */
  runnerWentOffline?: boolean;
  emptyMessage?: string;
}) {
  const groups = useMemo(() => {
    const normalizedQuery = normalizeSearchQuery(searchQuery);
    const roots = repositories
      .map((repository) => ({ repository, path: relativizeToWorkspace(repository, workspaceRoot) }))
      .sort((a, b) => b.path.length - a.path.length);
    const byRepository = new Map<string, RepositoryChangedFile[]>();
    for (const file of (files ?? []).filter(
      (candidate) =>
        !isExplorerInternalPath(candidate.path) &&
        (showHidden || !candidate.path.split("/").some((part) => part.startsWith("."))) &&
        (!normalizedQuery ||
          `${candidate.name} ${candidate.path}`.toLowerCase().includes(normalizedQuery)),
    )) {
      const repository =
        file.repository ??
        roots.find(
          (root) => !root.path || file.path === root.path || file.path.startsWith(`${root.path}/`),
        )?.repository ??
        "";
      const key = repositories.length > 1 ? repository : "";
      const group = byRepository.get(key) ?? [];
      group.push(file);
      byRepository.set(key, group);
    }
    return [...byRepository.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repository, group]) => ({ repository, files: group.sort(compareChangedFiles(sort)) }));
  }, [files, repositories, workspaceRoot, showHidden, searchQuery, sort]);
  const explorerEntries = useMemo(
    () => ({
      entries: groups
        .flatMap((group) => group.files)
        .filter((file) => file.status !== "deleted")
        .map((file) => ({ path: file.path, directory: false })),
    }),
    [groups],
  );
  useExplorerTree(explorerEntries);
  if (isLoading && !files) {
    return <ContentSkeleton label="Loading files…" rows={3} />;
  }
  if (isError && !files) {
    // Runner not connected. If it went offline after being up (host
    // restarted), guide the user to send a message to reconnect. If the
    // session just hasn't started, it isn't "asleep" — show the empty
    // state rather than alarm the user.
    if (error instanceof RunnerOfflineError) {
      if (runnerWentOffline) return <RunnerAsleepHint />;
      return <p className="px-2 py-1 text-muted-foreground text-sm">No workspace changes yet</p>;
    }
    return (
      <p className="px-2 py-1 text-destructive text-sm">
        Failed to load: {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }
  if (!files || files.length === 0) {
    return <p className="px-2 py-1 text-muted-foreground text-sm">{emptyMessage}</p>;
  }
  const visibleFiles = (files ?? []).filter(
    (file) =>
      !isExplorerInternalPath(file.path) &&
      (showHidden || !file.path.split("/").some((part) => part.startsWith("."))),
  );
  const sorted = groups.flatMap((group) => group.files);
  const hiddenCount = files.length - visibleFiles.length;
  if (visibleFiles.length === 0) {
    return (
      <p className="px-2 py-1 text-muted-foreground text-sm">
        All changes are in hidden files.{" "}
        <TooltipButton
          type="button"
          className="cursor-pointer underline hover:text-foreground"
          onClick={onShowHidden}
        >
          Click to show
        </TooltipButton>
      </p>
    );
  }
  if (sorted.length === 0) {
    return (
      <p className="px-2 py-1 text-muted-foreground text-sm">
        No changed files match "{searchQuery.trim()}"
      </p>
    );
  }
  return (
    <>
      {hiddenCount > 0 && (
        <p className="px-2 py-1 text-muted-foreground text-sm">
          {hiddenCount} file{hiddenCount === 1 ? "" : "s"} hidden.{" "}
          <TooltipButton
            type="button"
            className="cursor-pointer underline hover:text-foreground"
            onClick={onShowHidden}
          >
            Click to show
          </TooltipButton>
        </p>
      )}
      <TooltipProvider>
        {groups.map((group) => (
          <div
            key={group.repository}
            role={repositories.length > 1 ? "group" : undefined}
            aria-label={
              repositories.length > 1 ? group.repository || "Outside Git repositories" : undefined
            }
          >
            {repositories.length > 1 && (
              <h3
                className="truncate px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
                title={group.repository}
              >
                {group.repository || "Outside Git repositories"}
              </h3>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.files.map((file) => (
                <FileListItem
                  key={file.path}
                  file={file}
                  isDeleted={file.status === "deleted"}
                  onFileSelect={onFileSelect}
                  conversationId={conversationId}
                />
              ))}
            </ul>
          </div>
        ))}
      </TooltipProvider>
    </>
  );
}
