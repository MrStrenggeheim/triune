// Modified for Triune.
import type * as TerminalsModule from "@/hooks/useTerminals";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceEnvironment } from "@/hooks/useWorkspaceChangedFiles";
import { useWorkspaceComparisonChanges } from "@/hooks/useWorkspaceComparisons";
import { useTerminals } from "@/hooks/useTerminals";
import { useWorkspaceResources } from "./useWorkspaceResources";
import { setExplorerGitScope } from "@/lib/explorerGitScope";
import {
  DEFAULT_WORKSPACE_COMPARISON,
  setWorkspaceComparison,
  useWorkspaceComparison,
} from "@/lib/workspaceComparison";
import { writeFilesPanelPreferences } from "@/lib/filesPanelPreferences";

vi.mock("@/hooks/useWorkspaceChangedFiles", () => ({
  useWorkspaceEnvironment: vi.fn(() => ({ data: { available: true, root: "/workspace" } })),
}));
vi.mock("@/hooks/useWorkspaceComparisons", () => ({
  useAgentTurnChoices: vi.fn(() => ({ data: undefined, isLoading: false })),
  useWorkspaceComparisonChanges: vi.fn(),
}));
vi.mock("@/hooks/useTerminals", async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalsModule>()),
  useTerminals: vi.fn(() => ({ terminals: [{ id: "terminal_tui_main" }, { id: "shell" }] })),
}));
afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(useWorkspaceComparisonChanges).mockReturnValue({
    data: {
      available: true,
      data: [{ path: "notes.md" }],
      repositories: [],
      root_is_repository: false,
    },
  } as unknown as ReturnType<typeof useWorkspaceComparisonChanges>);
});

it.each([
  { permissionLevel: null, shareWorkspaceFiles: false, browse: true },
  { permissionLevel: 2, shareWorkspaceFiles: false, browse: true },
  { permissionLevel: 1, shareWorkspaceFiles: false, browse: false },
  { permissionLevel: 1, shareWorkspaceFiles: true, browse: true },
])("gates file discovery and separates agent and shell terminals: %o", ({ browse, ...access }) => {
  const { result, rerender } = renderHook(
    ({ sessionId, terminalFirst }) =>
      useWorkspaceResources({ ...access, sessionId, terminalFirst, terminalPending: true }),
    { initialProps: { sessionId: "first", terminalFirst: false } },
  );
  expect(useWorkspaceEnvironment).toHaveBeenLastCalledWith("first", { enabled: browse });
  expect(useWorkspaceComparisonChanges).toHaveBeenLastCalledWith("first", {
    path: "",
    directories: [],
    enabled: browse,
  });
  expect(result.current.showFilesPanel).toBe(browse);
  expect(result.current.changedCount).toBe(1);
  expect(result.current.isChangedPath("notes.md")).toBe(true);
  expect(result.current.isChangedPath("unknown.md")).toBe(false);
  expect(result.current.openTerminals).toEqual(["terminal:terminal_tui_main", "terminal:shell"]);
  rerender({ sessionId: "second", terminalFirst: true });
  expect(useTerminals).toHaveBeenLastCalledWith("second", {
    reconcileWhilePending: true,
    workspace: null,
  });
  expect(result.current.agentTerminal?.id).toBe("terminal_tui_main");
  expect(result.current.openTerminals).toEqual(["terminal:shell"]);
});

it("keeps a hidden pane's cached change count without observing comparisons", () => {
  const { result, rerender } = renderHook(
    ({ visible }) => useWorkspaceResources({ sessionId: "docked", permissionLevel: 2, visible }),
    { initialProps: { visible: false } },
  );
  expect(useWorkspaceComparisonChanges).toHaveBeenLastCalledWith("docked", {
    path: "",
    directories: [],
    enabled: false,
  });
  expect(result.current.changedCount).toBe(1);
  rerender({ visible: true });
  expect(useWorkspaceComparisonChanges).toHaveBeenLastCalledWith("docked", {
    path: "",
    directories: [],
    enabled: true,
  });
});

it("uses the published nested comparison scope for both the counter and file links", () => {
  const files = ["repo/a.ts", "repo/nested/b.ts", "repo/deleted.ts"];
  vi.mocked(useWorkspaceComparisonChanges).mockImplementation(
    (_sessionId, options) =>
      ({
        data: {
          available: true,
          data: options?.path === "repo" ? files.map((path) => ({ path })) : [],
          repositories: ["repo"],
          root_is_repository: options?.path === "repo",
        },
      }) as unknown as ReturnType<typeof useWorkspaceComparisonChanges>,
  );
  const { result, rerender } = renderHook(
    ({ sessionId }) => useWorkspaceResources({ sessionId, permissionLevel: 2 }),
    { initialProps: { sessionId: "nested-counter" } },
  );
  expect(result.current.changedCount).toBe(0);
  act(() =>
    setExplorerGitScope("nested-counter", {
      path: "repo",
      directories: ["repo/nested", "repo"],
    }),
  );
  expect(useWorkspaceComparisonChanges).toHaveBeenLastCalledWith("nested-counter", {
    path: "repo",
    directories: ["repo", "repo/nested"],
    enabled: true,
  });
  expect(result.current.changedCount).toBe(3);
  for (const path of files) expect(result.current.isChangedPath(path)).toBe(true);
  expect(result.current.isChangedPath("ghost.md")).toBe(false);
  rerender({ sessionId: "counter-other-session" });
  expect(useWorkspaceComparisonChanges).toHaveBeenLastCalledWith("counter-other-session", {
    path: "",
    directories: [],
    enabled: true,
  });
  expect(result.current.changedCount).toBe(0);
});

it("counts only the selected comparison, deduplicates paths, and isolates sessions", () => {
  vi.mocked(useWorkspaceComparisonChanges).mockImplementation((sessionId) => {
    const { comparison } = useWorkspaceComparison(sessionId);
    return {
      data: {
        available: true,
        data:
          comparison.source === "last-turn"
            ? [{ path: "turn.ts" }, { path: "turn.ts" }, { path: "deleted.ts", status: "deleted" }]
            : [{ path: "live.ts" }],
        repositories: [],
        root_is_repository: false,
      },
    } as unknown as ReturnType<typeof useWorkspaceComparisonChanges>;
  });
  const first = renderHook(() =>
    useWorkspaceResources({ sessionId: "comparison-a", permissionLevel: 2 }),
  );
  const second = renderHook(() =>
    useWorkspaceResources({ sessionId: "comparison-b", permissionLevel: 2 }),
  );
  expect(first.result.current.changedCount).toBe(1);
  expect(first.result.current.isChangedPath("live.ts")).toBe(true);
  act(() =>
    setWorkspaceComparison("comparison-a", {
      ...DEFAULT_WORKSPACE_COMPARISON,
      source: "last-turn",
      turnId: "captured-turn",
    }),
  );
  expect(first.result.current.changedCount).toBe(2);
  expect(first.result.current.isChangedPath("turn.ts")).toBe(true);
  expect(first.result.current.isChangedPath("deleted.ts")).toBe(true);
  expect(first.result.current.isChangedPath("live.ts")).toBe(false);
  expect(second.result.current.changedCount).toBe(1);
  expect(second.result.current.isChangedPath("turn.ts")).toBe(false);
  act(() => writeFilesPanelPreferences({ showAgentChanges: true }));
  expect(first.result.current.changedCount).toBe(2);
  expect(second.result.current.changedCount).toBe(1);
  act(() => setWorkspaceComparison("comparison-a", DEFAULT_WORKSPACE_COMPARISON));
  expect(first.result.current.changedCount).toBe(1);
  expect(first.result.current.isChangedPath("turn.ts")).toBe(false);
});

it("keeps comparison discovery disabled without file access even when the overlay is enabled", () => {
  writeFilesPanelPreferences({ showAgentChanges: true });
  renderHook(() => useWorkspaceResources({ sessionId: "read-only-counter", permissionLevel: 1 }));
  expect(useWorkspaceComparisonChanges).toHaveBeenLastCalledWith("read-only-counter", {
    path: "",
    directories: [],
    enabled: false,
  });
});

it("returns an empty counter while comparison discovery has no data", () => {
  vi.mocked(useWorkspaceComparisonChanges).mockReturnValue({
    data: undefined,
    isLoading: true,
  } as unknown as ReturnType<typeof useWorkspaceComparisonChanges>);
  const { result } = renderHook(() =>
    useWorkspaceResources({ sessionId: "loading-counter", permissionLevel: 2 }),
  );
  expect(result.current.changedCount).toBe(0);
  expect(result.current.isChangedPath("notes.md")).toBe(false);
});
