// Modified for Triune.
import { useWorkbenchWorkspace, queryIdentity, resourceBase } from "@/lib/workbenchWorkspace";
import { useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { isTempConvId } from "@/lib/tempConversationId";
import {
  useWorkspaceEnvironment,
  useWorkspaceServeable,
  useSessionActive,
  useTrailingInvalidate,
  type WorkspaceChangedFile,
  type WorkspaceGitOptions,
} from "./useWorkspaceChangedFiles";
import {
  isAgentComparison,
  useWorkspaceComparison,
  type ComparisonTurn,
  type WorkspaceComparisonScope,
} from "@/lib/workspaceComparison";
import { FALLBACK_POLL_MS, usePollingInterval } from "./usePollingInterval";

export interface WorkspaceComparisonResult {
  available: boolean;
  data: (WorkspaceChangedFile & { repository?: string })[];
  repositories: string[];
  root_is_repository: boolean;
  turns?: ComparisonTurn[];
  warning?: string | null;
  coverage?: string;
}

/** Read choices only while the turn picker is open, without changing the active comparison. */
export function useAgentTurnChoices(sessionId: string | undefined, path: string, enabled: boolean) {
  return useQuery<{ turns: ComparisonTurn[]; warning?: string }>({
    queryKey: ["workspace-agent-turns", sessionId, path],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ source: "agent", path, baseline: "last_turn" });
      const response = await authenticatedFetch(
        `/v1/sessions/${encodeURIComponent(sessionId!)}/resources/environments/default/changes?${params}`,
        { signal },
      );
      if (!response.ok) throw await apiErrorFromResponse(response);
      const payload = await response.json();
      if (payload.source !== "agent")
        throw new Error("Update the host to select captured agent turns.");
      return { turns: payload.turns ?? [], warning: payload.warning };
    },
    enabled: enabled && !!sessionId && !isTempConvId(sessionId),
    staleTime: 5_000,
    retry: false,
  });
}

export function useWorkspaceComparisonChanges(
  sessionId: string | undefined,
  options: WorkspaceGitOptions & WorkspaceComparisonScope & { agentEnabled?: boolean } = {},
) {
  const workspace = useWorkbenchWorkspace(options.workspace);
  const workspaceId = options.workspaceId ?? workspace?.id;
  const view = options.view ?? "changes";
  const { comparison } = useWorkspaceComparison({
    ...options,
    workspaceId,
    view,
    conversationId: sessionId,
  });
  const querySessionId = isAgentComparison(comparison) ? comparison.sourceChatId : sessionId;
  const agent = isAgentComparison(comparison);
  const identity = agent ? querySessionId : queryIdentity(workspaceId, sessionId);
  const serveable = useWorkspaceServeable(querySessionId, agent ? null : workspace);
  const environment = useWorkspaceEnvironment(querySessionId, {
    enabled: options.enabled,
    workspace: agent ? null : workspace,
  });
  const active = useSessionActive(querySessionId);
  useTrailingInvalidate(identity, active, "workspace-comparison-changes");
  const path = options.path ?? "";
  const directories = [...new Set(options.directories ?? [])].sort().slice(0, 128);
  // File-change pushes invalidate session comparisons; this poll is the safety net.
  const refetchInterval = usePollingInterval({
    active: options.enabled !== false,
    intervalMs: FALLBACK_POLL_MS,
  });
  return useQuery<WorkspaceComparisonResult>({
    queryKey: [
      "workspace-comparison-changes",
      identity,
      path,
      comparison,
      directories,
      workspaceId,
      view,
      options.agentEnabled,
    ],
    queryFn: async ({ signal }) => {
      const params = agent
        ? new URLSearchParams({
            source: "agent",
            path,
            baseline: comparison.source === "last-turn" ? "last_turn" : "session",
            ...(comparison.turnId ? { turn_id: comparison.turnId } : {}),
          })
        : new URLSearchParams({
            operation: "changes",
            path,
            directories: JSON.stringify(directories),
            base: comparison.base,
            target: comparison.target,
          });
      const response = await authenticatedFetch(
        `${resourceBase(agent ? null : workspaceId, querySessionId)}/environments/default/${agent ? "changes" : "git"}?${params}`,
        { signal },
      );
      if (!response.ok) throw await apiErrorFromResponse(response);
      const payload = await response.json();
      if (agent && payload.source !== "agent")
        throw new Error("Update the host to compare captured agent changes.");
      return {
        ...payload,
        available: true,
        repositories: payload.repositories ?? [],
        root_is_repository: payload.root_is_repository === true,
      };
    },
    enabled:
      options.enabled !== false &&
      (!agent || options.agentEnabled !== false) &&
      !!identity &&
      (agent || !workspaceId ? !!querySessionId && !isTempConvId(querySessionId) : true) &&
      serveable !== false &&
      environment.data?.available === true,
    staleTime: 5_000,
    refetchInterval,
    retry: false,
    placeholderData: (previous, query) =>
      query?.queryKey[1] === identity &&
      query?.queryKey[2] === path &&
      JSON.stringify(query?.queryKey[3]) === JSON.stringify(comparison) &&
      query?.queryKey[5] === workspaceId &&
      query?.queryKey[6] === view &&
      query?.queryKey[7] === options.agentEnabled
        ? previous
        : undefined,
  });
}
