// Modified for Triune.
import type { WorkspaceChangedFile } from "@/hooks/useWorkspaceChangedFiles";
import { isExplorerInternalPath } from "@/lib/explorerOperations";

/** Fixed-width diffstat column so change counts do not shift adjacent controls. */
export const ROW_META_SLOT_CLASS = "w-14";

/** Shared width for direct status letters and propagated dots in row metadata. */
export const ROW_STATUS_SLOT_CLASS = "w-[22px]";

type ChangeStatus = WorkspaceChangedFile["status"];

// Conflicts are not represented by the comparison API yet.
const DESCENDANT_PRIORITY: readonly ChangeStatus[] = ["modified", "created", "deleted"];

export interface FolderStatus {
  direct?: ChangeStatus;
  descendant?: ChangeStatus;
  counts: Record<ChangeStatus, number>;
}

/** Aggregate supplied comparison entries, independently of loaded/visible children. */
export function folderStatuses(
  changes: readonly WorkspaceChangedFile[],
): Map<string, FolderStatus> {
  const result = new Map<string, FolderStatus>();
  function at(path: string): FolderStatus {
    let value = result.get(path);
    if (!value) {
      value = { counts: { modified: 0, created: 0, deleted: 0 } };
      result.set(path, value);
    }
    return value;
  }
  for (const change of new Map(changes.map((entry) => [entry.path, entry])).values()) {
    if (isExplorerInternalPath(change.path)) continue;
    if (change.type === "directory") at(change.path).direct = change.status;
    const parts = change.path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      at(parts.slice(0, depth).join("/")).counts[change.status] += 1;
    }
  }
  for (const value of result.values()) {
    value.descendant = DESCENDANT_PRIORITY.find((status) => value.counts[status] > 0);
  }
  return result;
}

export function gitStatusColor(status: ChangeStatus | undefined): string | undefined {
  switch (status) {
    case "created":
      return "text-green-500 dark:text-green-400";
    case "modified":
      return "text-amber-500 dark:text-amber-400";
    case "deleted":
      return "text-destructive";
  }
  return undefined;
}

/** One description for the path, direct status, descendant counts and ignore annotation. */
export function statusDescription(
  path: string,
  status?: ChangeStatus,
  folder?: FolderStatus,
  ignored = false,
): string {
  const lines = [path];
  if (folder) {
    if (folder.direct) lines.push(`Folder: ${gitStatusLabel(folder.direct)}`);
    const counts = DESCENDANT_PRIORITY.filter((key) => folder.counts[key] > 0).map(
      (key) => `${folder.counts[key]} ${gitStatusLabel(key).toLowerCase()}`,
    );
    if (counts.length) lines.push(`Descendants: ${counts.join(", ")}`);
  } else if (status) {
    lines.push(gitStatusLabel(status));
  }
  if (ignored) lines.push("Ignored by Git");
  return lines.join("\n");
}

export function gitStatusLetter(status: WorkspaceChangedFile["status"]): string {
  switch (status) {
    case "created":
      return "A";
    case "deleted":
      return "D";
    case "modified":
      return "M";
  }
}

export function gitStatusLabel(status: WorkspaceChangedFile["status"]): string {
  switch (status) {
    case "created":
      return "Added";
    case "deleted":
      return "Deleted";
    case "modified":
      return "Modified";
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  for (let i = 0; i < units.length; i += 1) {
    if (value < 1024 || i === units.length - 1) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}
