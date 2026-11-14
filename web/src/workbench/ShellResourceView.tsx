// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { RefreshCwIcon } from "lucide-react";
import type { BackgroundTaskInfo } from "@/lib/types";
import { useSessionShellResource, shellResourcePath } from "@/hooks/useSessionShellResources";
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
        <span className="text-muted-foreground">Read-only output</span>
        <HeaderActionButton
          aria-label="Refresh shell output"
          disabled={!active || !validIdentity || resource.isFetching}
          onClick={() => void resource.refetch()}
        >
          <RefreshCwIcon className="size-3.5" />
        </HeaderActionButton>
      </header>
      {resource.error && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {resource.error.message}
        </p>
      )}
      {!validIdentity && !resource.error && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          Shell resource identity is unavailable.
        </p>
      )}
      {task?.live_error && (
        <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
          Live shell unavailable. Showing retained output.
        </p>
      )}
      {resource.isLoading ? (
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
