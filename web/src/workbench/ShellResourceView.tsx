// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { RefreshCwIcon } from "lucide-react";
import type { BackgroundTaskInfo } from "@/lib/types";
import {
  useSessionShellResource,
  shellResourcePath,
  sessionShellResourceKey,
} from "@/hooks/useSessionShellResources";
import { useNotificationNotice } from "@/hooks/useNotificationNotice";
import { shellResourceErrorMessage } from "@/lib/shellResourceError";
import { shellState } from "@/lib/shellState";
import { SubagentTaskStatus } from "@/components/blocks/SubagentTaskRow";
import { HeaderActionButton } from "@/components/HeaderActionButton";
import { RetainedTerminalOutput } from "./TerminalInventoryView";

export function ShellResourceView({
  conversationId,
  shellResource,
  active,
}: {
  conversationId: string;
  shellResource: BackgroundTaskInfo;
  active: boolean;
}) {
  const resource = useSessionShellResource(conversationId, shellResource, active);
  const path = shellResourcePath(conversationId, shellResource);
  const validIdentity =
    !!path && (shellResource.resource_url == null || shellResource.resource_url === path);
  const task = resource.data;
  const outcome = shellState({ status: task?.status, exitCode: task?.exit_code });
  const offline =
    task && (("availability" in task && task.availability === "offline") || task.live_error);
  useNotificationNotice(
    `shell-output:${JSON.stringify(sessionShellResourceKey(conversationId, shellResource))}`,
    active && (resource.error || offline)
      ? {
          title: resource.error ? "Shell output unavailable" : "Shell runtime offline",
          description: resource.error
            ? shellResourceErrorMessage(resource.error)
            : "Showing retained output. Refresh after the runtime reconnects.",
          type: resource.error ? "error" : "warning",
          action: validIdentity
            ? { label: "Refresh", onClick: () => void resource.refetch() }
            : undefined,
        }
      : null,
  );

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-[var(--workspace-content)]"
      data-context-search-region="native"
      aria-label="Shell output"
    >
      <header className="workspace-control-header flex min-w-0 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="min-w-0 flex-1 truncate" title={task?.command ?? task?.description}>
          {task?.command ?? task?.description ?? "Shell"}
        </span>
        {task && <SubagentTaskStatus status={outcome} label={outcome.label} />}
        <span className="text-muted-foreground">Read-only output</span>
        <HeaderActionButton
          aria-label="Refresh shell output"
          disabled={!active || !validIdentity || resource.isFetching}
          onClick={() => void resource.refetch()}
        >
          <RefreshCwIcon className="size-3.5" />
        </HeaderActionButton>
      </header>
      {!validIdentity && !resource.error && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          Shell resource identity is unavailable.
        </p>
      )}
      {resource.error && !task ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          Shell output is unavailable. Use Refresh to try again.
        </p>
      ) : resource.isLoading ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          Loading shell output…
        </p>
      ) : (
        <RetainedTerminalOutput terminal={{ output: task?.output ?? "" }} />
      )}
      {task?.exit_code != null && (
        <p className="px-3 py-2 text-xs text-muted-foreground">Exit code: {task.exit_code}</p>
      )}
    </section>
  );
}
