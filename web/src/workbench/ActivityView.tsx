// Modified for Triune.
import { useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHosts } from "@/hooks/useHosts";
import { useViewerId } from "@/hooks/useViewerId";
import { authenticatedFetch } from "@/lib/identity";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import { useResourceViewState } from "@/lib/panelFolder";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import {
  ActivityFilterControl,
  ChatActivityPanel,
  type ActivityFilter,
  type ChatActivityPanelProps,
  type ChatActivityTerminalTarget,
} from "@/shell/ChatActivityPanel";
import type { WorkspaceSelection } from "@/shell/WorkspaceSelectionDialog";
import { ActivitySourcePicker } from "./ActivitySourcePicker";
import { TerminalInventoryView } from "./TerminalInventoryView";

export type ActivitySource =
  | { kind: "chat"; conversationId: string }
  | { kind: "host"; hostId: string; workspace?: WorkbenchWorkspace };

export interface ActivityViewProps {
  viewId?: string;
  source?: ActivitySource | null;
  active?: boolean;
  focusAgentId?: string;
  focusShellId?: string;
  linkRequestId?: string;
  onSourceChange: (source: ActivitySource) => void | Promise<void>;
  onOpenTerminal: (target: ChatActivityTerminalTarget) => void;
  onNewTerminal: (workspace: WorkbenchWorkspace) => void;
  onOpenAgent?: ChatActivityPanelProps["onOpenAgent"];
  onConsumeLinkIntent?: ChatActivityPanelProps["onConsumeLinkIntent"];
  canStopAgent?: ChatActivityPanelProps["canStopAgent"];
  onStopAgent?: ChatActivityPanelProps["onStopAgent"];
}

async function fetchWorkspaces({ signal }: { signal: AbortSignal }): Promise<WorkbenchWorkspace[]> {
  const response = await authenticatedFetch("/v1/workbench-workspaces", { signal });
  if (!response.ok) throw await apiErrorFromResponse(response);
  const payload = await response.json();
  return payload.data;
}

/** Captured origin is controlled by the shell; focused chat state is never consulted. */
export function ActivityView(props: ActivityViewProps) {
  const { source, onSourceChange, onOpenTerminal } = props;
  const queryClient = useQueryClient();
  const viewerId = useViewerId();
  const scope = resourceViewStorageScope();
  const workspacesKey = ["workbench-workspaces", scope] as const;
  const origin = JSON.stringify([scope, source]);
  const currentOrigin = useRef(origin);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  currentOrigin.current = origin;
  function assertOrigin() {
    if (!viewerId || scope !== resourceViewStorageScope() || currentOrigin.current !== origin)
      throw new Error("Activity source changed. Choose the source again.");
  }
  async function changeSource(next: ActivitySource) {
    assertOrigin();
    await onSourceChange(next);
  }
  async function chooseWorkspace({ hostId, path }: WorkspaceSelection) {
    assertOrigin();
    if (!hostId) throw new Error("Choose a host for this workspace.");
    const response = await authenticatedFetch("/v1/workbench-workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host_id: hostId, root: path }),
    });
    if (!response.ok) throw await apiErrorFromResponse(response);
    const workspace = (await response.json()) as WorkbenchWorkspace;
    if (
      !workspace.id ||
      workspace.host_id !== hostId ||
      workspace.target_kind !== "host" ||
      !workspace.root
    )
      throw new Error("The server returned an invalid host workspace.");
    if (
      !mounted.current ||
      currentOrigin.current !== origin ||
      scope !== resourceViewStorageScope()
    )
      return;
    assertOrigin();
    await onSourceChange({ kind: "host", hostId, workspace });
    void queryClient.invalidateQueries({ queryKey: workspacesKey });
  }
  const sourceControl = (
    <ActivitySourcePicker
      key={origin}
      source={source}
      onChange={changeSource}
      onChooseWorkspace={chooseWorkspace}
    />
  );
  if (!source) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--workspace-content)]">
        <header className="workspace-control-header flex shrink-0 items-center border-b bg-[var(--workspace-content)] px-2">
          {sourceControl}
        </header>
        <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
          Choose a host or chat to view its activity.
        </div>
      </div>
    );
  }
  if (source.kind === "chat") {
    return (
      <ChatActivityPanel
        viewId={props.viewId}
        conversationId={source.conversationId}
        rootSessionId={source.conversationId}
        active={props.active}
        focusAgentId={props.focusAgentId}
        focusShellId={props.focusShellId}
        linkRequestId={props.linkRequestId}
        sourceControl={sourceControl}
        onOpenAgent={props.onOpenAgent}
        onConsumeLinkIntent={props.onConsumeLinkIntent}
        canStopAgent={props.canStopAgent}
        onStopAgent={props.onStopAgent}
        onOpenTerminal={onOpenTerminal}
      />
    );
  }
  return (
    <HostActivity
      key={JSON.stringify([scope, source.hostId, source.workspace?.id])}
      {...props}
      source={source}
      scope={scope}
      viewerId={viewerId}
      sourceControl={sourceControl}
    />
  );
}

function HostActivity({
  viewId,
  source,
  scope,
  viewerId,
  active = true,
  sourceControl,
  onOpenTerminal,
  onNewTerminal,
  focusShellId,
  linkRequestId,
  onConsumeLinkIntent,
}: ActivityViewProps & {
  source: Extract<ActivitySource, { kind: "host" }>;
  scope: string;
  viewerId: string | null;
  sourceControl: ReactNode;
}) {
  const hosts = useHosts({ enabled: active });
  const queryClient = useQueryClient();
  const workspacesKey = ["workbench-workspaces", scope] as const;
  const [filter, setFilter] = useResourceViewState<ActivityFilter>(
    source.workspace?.id ?? source.hostId,
    viewId,
    "activity-filter",
    "All",
  );
  const workspaces = useQuery({
    queryKey: workspacesKey,
    queryFn: fetchWorkspaces,
    enabled: active && !!viewerId,
    staleTime: 2_000,
    refetchInterval: active && viewerId ? 5_000 : false,
    retry: false,
    throwOnError: false,
  });
  const host = hosts.data?.find((candidate) => candidate.host_id === source.hostId);
  const roots =
    workspaces.data?.filter(
      (workspace) =>
        workspace.host_id === source.hostId &&
        workspace.target_kind === "host" &&
        workspace.id === source.workspace?.id &&
        workspace.root === source.workspace.root,
    ) ?? [];
  const authorized = !!viewerId && !!host && !hosts.error;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--workspace-content)]">
      <header className="workspace-control-header flex shrink-0 items-center gap-1 border-b bg-[var(--workspace-content)] px-2">
        {sourceControl}
        <ActivityFilterControl value={filter} onChange={setFilter} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh host activity"
          disabled={workspaces.isFetching}
          onClick={() => {
            void hosts.refetch();
            void workspaces.refetch();
            for (const workspace of roots)
              void queryClient.invalidateQueries({
                queryKey: ["workbench-terminal-history", workspace.id],
              });
          }}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {workspaces.error && (
          <p role="alert" className="p-3 text-sm text-destructive">
            Could not refresh host workspaces: {workspaces.error.message}
          </p>
        )}
        {(hosts.isLoading || workspaces.isLoading) && (
          <p role="status" className="p-3 text-sm">
            Loading host activity…
          </p>
        )}
        {!authorized && !hosts.isLoading && (
          <p role="status" className="p-3 text-sm text-muted-foreground">
            Host unavailable. Refresh to check access.
          </p>
        )}
        {authorized && !workspaces.isLoading && roots.length === 0 && !workspaces.error && (
          <p className="p-3 text-sm text-muted-foreground">
            Selected workspace unavailable. Choose a host workspace to view its shells.
          </p>
        )}
        {filter === "Agents" && (
          <p role="status" className="p-3 text-sm text-muted-foreground">
            Host workspaces contain independent shells. Choose a chat to view agents.
          </p>
        )}
        {authorized &&
          filter !== "Agents" &&
          roots.map((workspace) => (
            <TerminalInventoryView
              key={workspace.id}
              embedded
              workspace={{
                ...workspace,
                available:
                  !workspaces.error && host.status === "online" && workspace.available !== false,
              }}
              active={active}
              focusShellId={focusShellId}
              linkRequestId={linkRequestId}
              onConsumeLinkIntent={onConsumeLinkIntent}
              onOpenTerminal={(terminalId) =>
                onOpenTerminal({ workspaceId: workspace.id, sessionId: "", terminalId })
              }
              onNewTerminal={() => onNewTerminal(workspace)}
            />
          ))}
      </div>
    </div>
  );
}
