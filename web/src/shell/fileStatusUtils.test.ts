// Modified for Triune.
import { describe, expect, it } from "vitest";
import type { WorkspaceChangedFile } from "@/hooks/useWorkspaceChangedFiles";
import { folderStatuses, gitStatusColor, statusDescription } from "./fileStatusUtils";

function change(path: string, status: WorkspaceChangedFile["status"]): WorkspaceChangedFile {
  return {
    path,
    name: path.split("/").at(-1)!,
    status,
    bytes: null,
    modified_at: null,
    lines_added: null,
    lines_removed: null,
  };
}

describe("folderStatuses", () => {
  it.each([
    ["created", "modified", "modified"],
    ["modified", "deleted", "modified"],
    ["created", "deleted", "created"],
    ["deleted", "deleted", "deleted"],
  ] as const)("prioritizes %s and %s as %s regardless of order", (first, second, expected) => {
    const changes = [change("src/a", first), change("src/deep/b", second)];
    for (const entries of [changes, changes.toReversed()]) {
      expect(folderStatuses(entries).get("src")?.descendant).toBe(expected);
    }
  });

  it("counts unique paths through all ancestors without leaking to sibling prefixes", () => {
    const edited = change("src/deep/edit.ts", "modified");
    const statuses = folderStatuses([
      edited,
      edited,
      change("src/.hidden.ts", "created"),
      change("src/gone.ts", "deleted"),
      change("src-other/new.ts", "created"),
      change("src/.omnigent-trash/file", "created"),
      change("src/.omnigent-transfers/file", "modified"),
      change("src/.omnigent-upload-123", "created"),
    ]);
    expect(statuses.get("src")).toEqual({
      counts: { modified: 1, created: 1, deleted: 1 },
      descendant: "modified",
    });
    expect(statuses.get("src/deep")?.counts.modified).toBe(1);
    expect(statuses.get("src-other")?.descendant).toBe("created");
  });

  it("keeps direct evidence separate and never infers it from children or an untyped match", () => {
    const changes = [change("src/new.ts", "created"), change("src", "created")];
    expect(folderStatuses(changes).get("src")?.direct).toBeUndefined();
    const statuses = folderStatuses([
      ...changes,
      { ...change("src", "deleted"), type: "directory" },
    ]);
    expect(statuses.get("src")).toEqual({
      direct: "deleted",
      descendant: "created",
      counts: { modified: 0, created: 1, deleted: 0 },
    });
    expect(
      folderStatuses([{ ...change("empty", "created"), type: "directory" }]).get("empty"),
    ).toEqual({
      direct: "created",
      descendant: undefined,
      counts: { modified: 0, created: 0, deleted: 0 },
    });
  });
});

describe("statusDescription", () => {
  it("explains direct and mixed descendant statuses separately with the ignored annotation", () => {
    const folder = folderStatuses([
      { ...change("src", "created"), type: "directory" },
      change("src/one", "modified"),
      change("src/two", "modified"),
      change("src/three", "created"),
      change("src/four", "deleted"),
    ]).get("src");
    expect(statusDescription("src", undefined, folder, true)).toBe(
      "src\nFolder: Added\nDescendants: 2 modified, 1 added, 1 deleted\nIgnored by Git",
    );
  });

  it("describes unchanged and changed files without inventing folder state", () => {
    expect(statusDescription("a.ts")).toBe("a.ts");
    expect(statusDescription("a.ts", "modified")).toBe("a.ts\nModified");
    expect(statusDescription("a.ts", undefined, undefined, true)).toBe("a.ts\nIgnored by Git");
  });

  it("uses upstream theme-aware amber for modified letters, dots and folder propagation", () => {
    expect(gitStatusColor("modified")).toBe("text-amber-500 dark:text-amber-400");
    const folder = folderStatuses([
      change("src/edit.ts", "modified"),
      change("src/new.ts", "created"),
      change("src/gone.ts", "deleted"),
    ]).get("src")!;
    expect(gitStatusColor(folder.descendant)).toBe(gitStatusColor("modified"));
    expect(gitStatusColor("created")).toContain("text-green-500");
    expect(gitStatusColor("deleted")).toBe("text-destructive");
    expect(gitStatusColor(undefined)).toBeUndefined();
  });
});
