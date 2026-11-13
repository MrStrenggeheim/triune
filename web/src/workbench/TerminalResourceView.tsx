// Modified for Triune.

import { lazy, Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon, SquareIcon } from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip";
import { WorkbenchWorkspaceProvider, type WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import { useSession } from "@/hooks/useSession";
import { terminalDisplayLabel, useDeleteTerminal } from "@/hooks/useTerminals";
import { CloseShellDialog } from "@/shell/CloseShellDialog";
import { isOwnerLevel, LEVEL_OWNER } from "@/lib/permissionsApi";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import type { ChatActivityResponse } from "@/hooks/useChatActivity";
import {
  manualTerminalRecord,
  RetainedTerminalOutput,
  terminalEnded,
  terminalHistoryKey,
  terminalStateLabel,
} from "./TerminalInventoryView";

const TerminalView = lazy(() =>
  import("@/components/blocks/TerminalView").then((module) => ({ default: module.TerminalView })),
);

/** Recorded commands are read through their owner; this view never attaches a terminal. */
export function RetainedActivityView({
  conversationId,
  activity,
  active,
}: {
  conversationId: string;
  activity: { name: string; state: string; entryIds: string[] };
  active: boolean;
}) {
  const history = useQuery<ChatActivityResponse>({
    queryKey: ["chat-activity", conversationId],
    queryFn: async ({ signal }) => {
      const response = await authenticatedFetch(
        `/v1/sessions/${encodeURIComponent(conversationId)}/activity`,
        { signal },
      );
      if (!response.ok) throw await apiErrorFromResponse(response);
      return response.json();
    },
    enabled: active,
    staleTime: 5_000,
    retry: false,
  });
  const entries = history.data?.data.filter((entry) => activity.entryIds.includes(entry.id)) ?? [];
  const output = entries
    .map(
      (entry) =>
        `${entry.kind === "command" ? `$ ${entry.name}\n` : ""}${entry.output ?? ""}${entry.exit_status != null ? `\nExit code: ${entry.exit_status}` : ""}`,
    )
    .join("\n\n");
  return (
    <div className="flex h-full min-h-0 flex-col" data-context-search-region="native">
      <div className="workspace-control-header flex items-center gap-2 border-b px-3 text-xs">
        <span className="min-w-0 flex-1 truncate">{activity.name}</span>
        <span className="text-muted-foreground">Retained output</span>
        <TooltipButton
          type="button"
          className="flex size-7 items-center justify-center rounded hover:bg-muted"
          aria-label="Refresh history"
          onClick={() => void history.refetch()}
        >
          <RefreshCwIcon className="size-3.5" />
        </TooltipButton>
      </div>
      {history.error ? (
        <p role="alert" className="p-3 text-sm">
          {history.error.message}
        </p>
      ) : history.isLoading ? (
        <p role="status" className="p-3 text-sm">
          Loading retained output…
        </p>
      ) : (
        <RetainedTerminalOutput terminal={{ output }} />
      )}
    </div>
  );
}

interface TerminalResourceProps {
  workspace?: WorkbenchWorkspace;
  conversationId?: string;
  terminalId: string;
  active: boolean;
  manual?: boolean;
}

export function TerminalResourceView(props: TerminalResourceProps) {
  // Dialogs and pending results belong to the captured resource, not the next selection.
  return (
    <TerminalResourceContent
      key={JSON.stringify([
        props.manual !== false,
        props.manual !== false && props.workspace ? props.workspace.id : props.conversationId,
        props.terminalId,
      ])}
      {...props}
    />
  );
}

function TerminalResourceContent({
  workspace,
  conversationId,
  terminalId,
  active,
  manual = true,
}: TerminalResourceProps) {
  const target = manual ? workspace : undefined;
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const stop = useDeleteTerminal(conversationId ?? "", target ?? null);
  const { session, error: sessionError } = useSession(manual ? undefined : conversationId);
  const canWrite = manual
    ? !!target && (target.permission_level ?? 0) >= LEVEL_OWNER && target.available !== false
    : !!session && !sessionError && isOwnerLevel(session.permissionLevel ?? null);
  const detail = useQuery({
    queryKey: [...terminalHistoryKey(target?.id ?? ""), "detail", terminalId],
    queryFn: async ({ signal }) => {
      const response = await authenticatedFetch(
        `/v1/workbench-workspaces/${encodeURIComponent(target!.id)}/terminals/${encodeURIComponent(terminalId)}`,
        { signal },
      );
      if (!response.ok) throw await apiErrorFromResponse(response);
      return manualTerminalRecord(await response.json());
    },
    enabled: !!target && active,
    refetchInterval: active && target ? 5_000 : false,
    staleTime: 2_000,
    retry: false,
    throwOnError: false,
  });
  const terminal = target ? detail.data : undefined;
  const ended = !!terminal && terminalEnded(terminal);
  const retained =
    !!terminal && (ended || terminal.connectivity !== "connected" || terminal.state !== "running");
  const label = terminal ? terminalDisplayLabel(terminal) : terminalId;
  const canStop =
    canWrite &&
    !ended &&
    !stopping &&
    !stop.isPending &&
    (!target || (!!terminal && terminal.connectivity === "connected" && !detail.error));

  async function confirm() {
    setConfirmStop(false);
    if (!canStop) return;
    setStopping(true);
    setStopError(null);
    try {
      await stop.mutateAsync(terminalId);
      // HTTP acceptance alone is not an exit status; re-read the captured owner's record.
      if (target) await queryClient.invalidateQueries({ queryKey: terminalHistoryKey(target.id) });
    } catch (error) {
      setStopError(error instanceof Error ? error.message : String(error));
    } finally {
      setStopping(false);
    }
  }

  return (
    <WorkbenchWorkspaceProvider value={target ?? null}>
      <div className="flex h-full min-h-0 flex-col" data-context-search-region="native">
        {manual && (
          <div className="workspace-control-header flex items-center gap-2 border-b px-3 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
            <span role="status">
              {stopping || stop.isPending
                ? "Stopping…"
                : terminal
                  ? terminalStateLabel(terminal)
                  : target
                    ? "Checking shell…"
                    : "Shell"}
            </span>
            {target && (
              <TooltipButton
                type="button"
                aria-label="Refresh shell"
                disabled={detail.isFetching}
                onClick={() => void detail.refetch()}
                className="flex size-7 items-center justify-center rounded hover:bg-muted"
              >
                <RefreshCwIcon className="size-3.5" />
              </TooltipButton>
            )}
            {!ended && (
              <TooltipButton
                type="button"
                aria-label="Stop shell"
                disabled={!canStop}
                onClick={() => setConfirmStop(true)}
                className="flex size-7 items-center justify-center rounded hover:bg-muted"
              >
                <SquareIcon className="size-3.5" />
              </TooltipButton>
            )}
          </div>
        )}
        {stopError && (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            Could not stop the shell: {stopError}
          </p>
        )}
        {target && detail.error && (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            Could not refresh shell state: {detail.error.message}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {manual && !target ? (
            <p role="status" className="p-3 text-sm">
              Choose a workspace to open this manual shell.
            </p>
          ) : retained && terminal ? (
            <RetainedTerminalOutput terminal={terminal} />
          ) : target && !terminal ? (
            <p role="status" className="p-3 text-sm">
              {detail.error
                ? "Shell history is unavailable. Refresh to retry."
                : "Loading terminal…"}
            </p>
          ) : (
            <Suspense
              fallback={
                <p role="status" className="p-3 text-sm">
                  Loading terminal…
                </p>
              }
            >
              <TerminalView
                workspaceId={target?.id}
                sessionId={target ? "" : (conversationId ?? "")}
                terminalId={terminalId}
                readOnly={!canWrite || !!(target && detail.error)}
                active={active}
                focusOnConnect={false}
              />
            </Suspense>
          )}
        </div>
        {manual && (
          <CloseShellDialog
            open={confirmStop}
            shellLabel={label}
            onCancel={() => setConfirmStop(false)}
            onConfirm={() => void confirm()}
          />
        )}
      </div>
    </WorkbenchWorkspaceProvider>
  );
}
