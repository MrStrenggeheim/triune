// Modified for Triune.
import { OperationStatus } from "@/components/ui/loading";
import { useContext, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/routing";
import { Button } from "@/components/ui/button";
import { WorkspaceSelectionDialog } from "@/shell/WorkspaceSelectionDialog";
import { WorkspaceSelector } from "@/shell/WorkspaceSelector";
import { SwitchHostDialog } from "@/shell/SwitchHostDialog";
import { useSessionActionRestrictions } from "@/hooks/useSessionActionRestrictions";
import { useHosts } from "@/hooks/useHosts";
import { FileViewerContext } from "@/shell/FileViewerContext";
import { useRecentWorkspaces } from "@/hooks/useRecentWorkspaces";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { notify, toast, updateNotification } from "@/lib/notifications";
import { useChatStore } from "@/store/chatStore";

interface Operation {
  id: string;
  phase: string;
  blocked: boolean;
  target_workspace: string;
  previous_workspace: string;
  error: string | null;
  restored?: boolean;
  recovery_error?: string | null;
}
interface Snapshot {
  host_id: string;
  workspace: string;
  runner_id: string | null;
  operation: Operation | null;
  can_recover: boolean;
  unchanged?: boolean;
  validated_workspace?: string;
}
const PHASES: Record<string, string> = {
  stopping: "Stopping agent…",
  starting: "Starting agent…",
  connecting: "Reconnecting agent…",
};

async function readWorkspace(sessionId: string): Promise<Snapshot> {
  const response = await authenticatedFetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/workspace`,
  );
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json();
}

interface WorkspaceSwitchProps {
  sessionId: string;
  hostId: string;
  workspace: string;
  disabledReason?: string;
  onReconnect?: () => void;
}

/** Keep an asynchronous switch attached to its original chat across composer reuse. */
export function WorkspaceSwitchControl(props: WorkspaceSwitchProps) {
  return <WorkspaceSwitchState key={props.sessionId} {...props} />;
}

function WorkspaceSwitchState({
  sessionId,
  hostId,
  workspace,
  disabledReason,
  onReconnect,
}: WorkspaceSwitchProps) {
  const [open, setOpen] = useState(false);
  const [hostTarget, setHostTarget] = useState<{ hostId: string; path: string } | null>(null);
  const { switchHostDisabledReason } = useSessionActionRestrictions(sessionId, { hostId });
  const [checking, setChecking] = useState(false);
  const [awaitingDecision, setAwaitingDecision] = useState(false);
  const prepareSequence = useRef(0);
  useEffect(
    () => () => {
      prepareSequence.current += 1;
    },
    [],
  );
  const [folder, setFolder] = useState(workspace);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [, setSearchParams] = useSearchParams();
  const fileContext = useContext(FileViewerContext);
  const { addRecent } = useRecentWorkspaces(hostId);
  const { data: hosts } = useHosts({ includeSandbox: true });
  const hostLabel = hosts?.find((host) => host.host_id === hostId)?.name ?? hostId;
  const activeNotice = useRef<string | undefined>(undefined);
  const settledNotice = useRef<string | undefined>(undefined);
  const query = useQuery({
    queryKey: ["session-workspace", sessionId],
    queryFn: () => readWorkspace(sessionId),
    refetchInterval: (q) => (q.state.data?.operation?.blocked ? 1000 : false),
    retry: false,
  });
  const operation = query.data?.operation;
  const busy = !!operation?.blocked && !query.data?.can_recover;

  const reflect = (snapshot: Snapshot, reveal = false) => {
    const op = snapshot.operation;
    if (!op) {
      if (!mutation.isPending) useChatStore.getState().setWorkspaceSwitching(sessionId, false);
      return;
    }
    const id = `workspace-switch:${sessionId}:${op.id}`;
    if (mutation.isPending && activeNotice.current && activeNotice.current !== id) return;
    const switching = op.blocked;
    useChatStore.getState().setWorkspaceSwitching(sessionId, switching);
    if (!switching && activeNotice.current === id && settledNotice.current !== id) {
      settledNotice.current = id;
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["chat-workbench-workspace"] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    }
    const entry = {
      title:
        op.phase === "completed"
          ? "Workspace changed"
          : op.phase === "failed"
            ? "Workspace change failed"
            : "Changing workspace",
      description: op.error ?? `${op.previous_workspace} → ${op.target_workspace}`,
      type:
        op.phase === "failed"
          ? ("error" as const)
          : op.blocked
            ? ("loading" as const)
            : ("success" as const),
      progress:
        op.blocked && op.phase !== "failed"
          ? { active: true, label: PHASES[op.phase] ?? "Changing workspace…" }
          : undefined,
    };
    if (activeNotice.current === id) updateNotification(id, entry, { reveal });
    else if (switching || reveal) {
      notify({ id, ...entry });
      activeNotice.current = id;
    }
  };
  useEffect(() => {
    if (query.data) reflect(query.data);
  }, [query.data, query.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const mutation = useMutation({
    mutationFn: async ({ target, recover }: { target: string; recover?: string }) => {
      const before = await readWorkspace(sessionId);
      if ((before.workspace !== workspace || before.host_id !== hostId) && !recover) {
        queryClient.setQueryData(["session-workspace", sessionId], before);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        throw new Error(
          "Workspace changed elsewhere. Reopen the switcher and review the current folder.",
        );
      }
      const requestId = crypto.randomUUID();
      activeNotice.current = `workspace-switch:${sessionId}:${requestId}`;
      toast.loading("Changing workspace", { id: activeNotice.current, description: target });
      useChatStore.getState().setWorkspaceSwitching(sessionId, true);
      const response = await authenticatedFetch(
        `/v1/sessions/${encodeURIComponent(sessionId)}/workspace`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: requestId,
            workspace: target,
            expected_host_id: before.host_id,
            expected_workspace: before.workspace,
            expected_runner_id: before.runner_id,
            ...(recover ? { recover_operation_id: recover } : {}),
          }),
        },
      );
      if (!response.ok) throw await apiErrorFromResponse(response);
      return (await response.json()) as Snapshot;
    },
    onSuccess: async (snapshot) => {
      queryClient.setQueryData(["session-workspace", sessionId], snapshot);
      if (snapshot.unchanged) {
        useChatStore.getState().setWorkspaceSwitching(sessionId, false);
        if (activeNotice.current)
          updateNotification(
            activeNotice.current,
            {
              title: "Workspace unchanged",
              type: "info",
              description: snapshot.workspace,
              progress: undefined,
            },
            { reveal: true },
          );
        setOpen(false);
        return;
      } else reflect(snapshot, true);
      if (snapshot.operation?.blocked && snapshot.operation.phase !== "failed") return;
      if (snapshot.operation?.phase === "failed") {
        setError(snapshot.operation.error);
        return;
      }
      if (snapshot.operation?.previous_workspace) addRecent(snapshot.operation.previous_workspace);
      addRecent(snapshot.workspace);
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["chat-workbench-workspace"] }),
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      ]);
      // Only clear this chat's file URL; an asynchronous switch may finish after navigation.
      if (useChatStore.getState().conversationId === sessionId)
        setSearchParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            for (const key of ["workspace", "file", "diff", "comment"]) next.delete(key);
            return next;
          },
          { replace: true },
        );
    },
    onError: async (failure) => {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message);
      let blocked: boolean;
      try {
        const snapshot = await readWorkspace(sessionId);
        blocked = !!snapshot.operation?.blocked;
        queryClient.setQueryData(["session-workspace", sessionId], snapshot);
        reflect(snapshot, true);
      } catch {
        blocked = true;
      }
      useChatStore.getState().setWorkspaceSwitching(sessionId, blocked);
      if (activeNotice.current)
        updateNotification(
          activeNotice.current,
          {
            title: "Workspace change not completed",
            description: message,
            type: "error",
            progress: undefined,
          },
          { reveal: true },
        );
    },
  });
  const changing = checking || mutation.isPending || busy;
  function closeDialog(next: boolean) {
    if (!next) prepareSequence.current += 1;
    setOpen(next);
  }
  async function change(target: string, recover?: string) {
    setError(null);
    const sequence = ++prepareSequence.current;
    setChecking(true);
    try {
      const before = await readWorkspace(sessionId);
      if ((before.workspace !== workspace || before.host_id !== hostId) && !recover) {
        queryClient.setQueryData(["session-workspace", sessionId], before);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        void queryClient.invalidateQueries({ queryKey: ["chat-workbench-workspace"] });
        throw new Error("The chat context changed elsewhere. Reopen the switcher to review it.");
      }

      const response = await authenticatedFetch(
        `/v1/sessions/${encodeURIComponent(sessionId)}/workspace`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            validate_only: true,
            request_id: crypto.randomUUID(),
            workspace: target,
            expected_host_id: before.host_id,
            expected_workspace: before.workspace,
            expected_runner_id: before.runner_id,
            ...(recover ? { recover_operation_id: recover } : {}),
          }),
        },
      );
      if (!response.ok) throw await apiErrorFromResponse(response);
      const prepared = (await response.json()) as Snapshot;
      if (sequence !== prepareSequence.current) return false;
      if (prepared.unchanged) {
        toast.info("Workspace unchanged", { description: prepared.workspace });
        closeDialog(false);
        return false;
      }
      if (fileContext?.beforeWorkspaceChange) {
        setAwaitingDecision(true);
        const approved = await new Promise<boolean>((resolve) => {
          fileContext.beforeWorkspaceChange!(
            () => resolve(true),
            () => resolve(false),
          );
        });
        setAwaitingDecision(false);
        if (!approved) return false;
      }
      if (sequence !== prepareSequence.current) return false;
      await mutation.mutateAsync({ target: prepared.validated_workspace ?? target, recover });
      return false;
    } catch (failure) {
      if (sequence !== prepareSequence.current) return false;
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message);
      toast.error("Could not change workspace", { description: message });
    } finally {
      setChecking(false);
      setAwaitingDecision(false);
    }
    return false;
  }
  return (
    <>
      <WorkspaceSelector
        hostLabel={hostLabel}
        menuOpen={open}
        path={
          changing ? "Changing workspace…" : operation?.blocked ? "Recover workspace" : workspace
        }
        data-testid="composer-workspace-dir"
        aria-label={`Change workspace: ${hostLabel}:${workspace}`}
        disabledReason={disabledReason}
        disabled={!!disabledReason && !operation?.blocked}
        onClick={() => {
          setFolder(operation?.blocked ? operation.target_workspace : workspace);
          setError(null);
          setOpen(true);
        }}
      />
      <WorkspaceSelectionDialog
        open={open}
        onOpenChange={closeDialog}
        hostId={hostId}
        hostLabel={hostLabel}
        allowHostChange={!switchHostDisabledReason && !operation?.blocked}
        hostActions={
          <>
            {switchHostDisabledReason && (
              <p className="px-2 py-2 text-xs text-muted-foreground">{switchHostDisabledReason}</p>
            )}
            {onReconnect && hosts?.find((host) => host.host_id === hostId)?.status !== "online" && (
              <Button type="button" variant="ghost" onClick={onReconnect}>
                Reconnect host
              </Button>
            )}
          </>
        }
        initialPath={folder}
        workspacePath={workspace}
        closeOnConfirm={false}
        busy={changing || (!!disabledReason && !query.data?.can_recover)}
        onConfirm={async ({ hostId: targetHostId, path }) => {
          if (targetHostId !== hostId) {
            if (!targetHostId || switchHostDisabledReason || operation?.blocked || changing)
              return false;
            const sequence = ++prepareSequence.current;
            if (fileContext?.beforeWorkspaceChange) {
              const approved = await new Promise<boolean>((resolve) => {
                fileContext.beforeWorkspaceChange!(
                  () => resolve(true),
                  () => resolve(false),
                );
              });
              if (!approved || sequence !== prepareSequence.current) return false;
            }
            setHostTarget({ hostId: targetHostId, path });
            return false;
          }
          setFolder(path);
          return change(path, query.data?.can_recover ? operation?.id : undefined);
        }}
        description="The agent restarts in the selected folder and continues this chat. Files and existing manual terminals stay where they are."
      >
        <p className="mt-2 text-xs text-muted-foreground">
          {operation?.blocked ? "Previous folder: " : "Current folder: "}
          {operation?.blocked ? operation.previous_workspace : (query.data?.workspace ?? workspace)}
        </p>
        {awaitingDecision && (
          <p role="status" className="text-sm text-muted-foreground">
            Review unsaved changes to continue.
          </p>
        )}
        {changing && !awaitingDecision && (
          <OperationStatus>
            {checking
              ? "Checking folder…"
              : (PHASES[operation?.phase ?? ""] ?? "Changing workspace…")}
          </OperationStatus>
        )}
        {(error || operation?.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? operation?.error}
            {operation?.restored ? " The original workspace was restored." : ""}
            {operation?.recovery_error ? ` Reconnect the agent: ${operation.recovery_error}` : ""}
          </p>
        )}
        {query.error && (
          <p role="alert" className="text-sm text-destructive">
            {query.error.message}
          </p>
        )}
        {query.data?.can_recover && (
          <Button
            type="button"
            variant="outline"
            disabled={changing}
            loading={changing}
            onClick={() => void change(operation!.previous_workspace, operation!.id)}
          >
            Restore original
          </Button>
        )}
      </WorkspaceSelectionDialog>
      {hostTarget && (
        <SwitchHostDialog
          open
          sessionId={sessionId}
          currentHostId={hostId}
          initialHostId={hostTarget.hostId}
          initialPath={hostTarget.path}
          onOpenChange={(next) => {
            if (!next) setHostTarget(null);
          }}
          onSwitched={() => {
            closeDialog(false);
            void queryClient.invalidateQueries({ queryKey: ["session-workspace", sessionId] });
            void queryClient.invalidateQueries({ queryKey: ["chat-workbench-workspace"] });
            if (useChatStore.getState().conversationId === sessionId)
              setSearchParams(
                (previous) => {
                  const next = new URLSearchParams(previous);
                  for (const key of ["workspace", "file", "diff", "comment"]) next.delete(key);
                  return next;
                },
                { replace: true },
              );
          }}
        />
      )}
    </>
  );
}
