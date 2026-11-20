// Modified for Triune.
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  findAgentTerminal,
  inventoryTerminals,
  terminalTabKey,
  useTerminals,
} from "@/hooks/useTerminals";
import { useWorkspaceEnvironment } from "@/hooks/useWorkspaceChangedFiles";
import { isEditorLevel } from "@/lib/permissionsApi";
import { getExplorerGitScope, subscribeExplorerGitScopes } from "@/lib/explorerGitScope";
import { useWorkspaceComparisonChanges } from "@/hooks/useWorkspaceComparisons";
/** Shared discovery for the full-session shell and grid workspaces. */
export function useWorkspaceResources({
  sessionId,
  permissionLevel,
  shareWorkspaceFiles,
  terminalFirst = false,
  terminalPending = false,
  workspace,
  visible = true,
}: {
  sessionId: string | undefined;
  permissionLevel: number | null;
  shareWorkspaceFiles?: boolean;
  terminalFirst?: boolean;
  terminalPending?: boolean;
  workspace?: WorkbenchWorkspace | null;
  /** Whether the owning pane is shown; hidden dock tabs keep cached changes without polling. */
  visible?: boolean;
}) {
  // View grants don't include files. Unknown levels stay permissive; the server enforces access.
  const canBrowseWorkspace =
    workspace != null || isEditorLevel(permissionLevel) || shareWorkspaceFiles === true;
  const environmentQuery = useWorkspaceEnvironment(sessionId, {
    enabled: canBrowseWorkspace,
    ...(workspace ? { workspace } : {}),
  });
  const scope = useSyncExternalStore(
    subscribeExplorerGitScopes,
    () =>
      getExplorerGitScope(
        workspace ? { workspaceId: workspace.id, conversationId: sessionId } : sessionId,
      ),
    () => getExplorerGitScope(undefined),
  );
  const changes = useWorkspaceComparisonChanges(sessionId, {
    ...scope,
    enabled: canBrowseWorkspace && visible,
    ...(workspace ? { workspace } : {}),
  });
  const changedPaths = useMemo(
    () => new Map((changes.data?.data ?? []).map((file) => [file.path, file])),
    [changes.data],
  );
  const isChangedPath = useCallback((path: string) => changedPaths.has(path), [changedPaths]);
  const { terminals } = useTerminals(sessionId ?? null, {
    reconcileWhilePending: terminalPending,
    workspace: null,
  });
  const agentTerminal = useMemo(() => findAgentTerminal(terminals), [terminals]);
  // Hide the agent terminal from shells only when it has its own Terminal view.
  const openTerminals = useMemo(
    () => inventoryTerminals(terminals, terminalFirst).map(terminalTabKey),
    [terminals, terminalFirst],
  );
  return {
    canBrowseWorkspace,
    environmentQuery,
    showFilesPanel:
      workspace != null || (canBrowseWorkspace && environmentQuery.data?.available !== false),
    changedCount: changedPaths.size,
    isChangedPath,
    terminals,
    agentTerminal,
    openTerminals,
  };
}
