// Modified for Triune.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHosts } from "@/hooks/useHosts";
import { useViewerId } from "@/hooks/useViewerId";
import { authenticatedFetch } from "@/lib/identity";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import { ChatActivityPanel, type ChatActivityTerminalTarget } from "@/shell/ChatActivityPanel";
import { WorkspaceSelectionDialog } from "@/shell/WorkspaceSelectionDialog";
import { ActivitySourcePicker } from "./ActivitySourcePicker";
import { TerminalInventoryView } from "./TerminalInventoryView";

export type ActivitySource =
  | { kind: "chat"; conversationId: string }
  | { kind: "host"; hostId: string; workspace?: WorkbenchWorkspace };

export interface ActivityViewProps {
  source?: ActivitySource | null;
  active?: boolean;
  onSourceChange: (source: ActivitySource) => void | Promise<void>;
  onOpenTerminal: (target: ChatActivityTerminalTarget) => void;
  onNewTerminal: (workspace: WorkbenchWorkspace) => void;
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
  async function changeSource(next: ActivitySource) {
    if (!viewerId || scope !== resourceViewStorageScope())
      throw new Error("Activity identity changed. Choose the source again.");
    if (next.kind === "chat" || next.workspace) return onSourceChange(next);
    // Workspace discovery is independent of chat grants and never resolves through a chat.
    const workspaces = await queryClient.fetchQuery({
      queryKey: workspacesKey,
      queryFn: fetchWorkspaces,
      staleTime: 2_000,
    });
    const roots = workspaces.filter(
      (workspace) => workspace.host_id === next.hostId && workspace.target_kind === "host",
    );
    const preferred =
      source?.kind === "host" && source.hostId === next.hostId ? source.workspace?.id : undefined;
    if (scope !== resourceViewStorageScope())
      throw new Error("Activity identity changed. Choose the source again.");
    await onSourceChange({
      ...next,
      workspace: roots.find((workspace) => workspace.id === preferred) ?? roots[0],
    });
  }
  if (!source) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--workspace-content)]">
        <header className="workspace-control-header flex shrink-0 items-center border-b bg-[var(--workspace-content)] px-2">
          <ActivitySourcePicker onChange={changeSource} />
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
        conversationId={source.conversationId}
        rootSessionId={source.conversationId}
        active={props.active}
        sourceControl={<ActivitySourcePicker source={source} onChange={changeSource} />}
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
      onSourceChange={changeSource}
    />
  );
}

function HostActivity({
  source,
  scope,
  viewerId,
  active = true,
  onSourceChange,
  onOpenTerminal,
  onNewTerminal,
}: ActivityViewProps & {
  source: Extract<ActivitySource, { kind: "host" }>;
  scope: string;
  viewerId: string | null;
}) {
  const hosts = useHosts({ enabled: active });
  const queryClient = useQueryClient();
  const workspacesKey = ["workbench-workspaces", scope] as const;
  const [pickerOpen, setPickerOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
      (workspace) => workspace.host_id === source.hostId && workspace.target_kind === "host",
    ) ?? [];
  const authorized = !!viewerId && !!host && !hosts.error;

  async function chooseRoot(root: string) {
    const response = await authenticatedFetch("/v1/workbench-workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host_id: source.hostId, root }),
    });
    if (!response.ok) throw await apiErrorFromResponse(response);
    const workspace = (await response.json()) as WorkbenchWorkspace;
    if (
      !workspace.id ||
      workspace.host_id !== source.hostId ||
      workspace.target_kind !== "host" ||
      !workspace.root
    )
      throw new Error("The server returned an invalid host workspace.");
    await queryClient.invalidateQueries({ queryKey: workspacesKey });
    if (mounted.current) await onSourceChange({ ...source, workspace });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--workspace-content)]">
      <header className="workspace-control-header flex shrink-0 items-center gap-1 border-b bg-[var(--workspace-content)] px-2">
        <ActivitySourcePicker source={source} onChange={onSourceChange} />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={!authorized || host.status !== "online"}
          onClick={() => setPickerOpen(true)}
        >
          <FolderIcon className="size-3.5" />
          Choose workspace
        </Button>
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
            No authorized workspaces on this host. Choose a workspace to create an independent
            shell.
          </p>
        )}
        {authorized &&
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
              onOpenTerminal={(terminalId) =>
                onOpenTerminal({ workspaceId: workspace.id, sessionId: "", terminalId })
              }
              onNewTerminal={() => onNewTerminal(workspace)}
            />
          ))}
      </div>
      {pickerOpen && (
        <WorkspaceSelectionDialog
          open
          onOpenChange={setPickerOpen}
          hostId={source.hostId}
          allowHostChange={false}
          initialPath={source.workspace?.root}
          workspacePath={source.workspace?.root}
          onConfirm={({ path }) => chooseRoot(path)}
        />
      )}
    </div>
  );
}
