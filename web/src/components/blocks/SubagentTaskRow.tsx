// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleIcon,
  ClockIcon,
  UnplugIcon,
} from "lucide-react";
import { ActivityRow } from "@/components/ActivityRow";
import { RunningDot } from "@/components/RunningDot";
import { Badge } from "@/components/ui/badge";
import type { AgentStatus } from "@/shell/subagentStatus";
import { cn } from "@/lib/utils";
import { formatSubagentTask } from "@/lib/subagentActivity";
import { formatStatusModelLabel, formatStatusEffortLabel } from "@/lib/composerModelLabel";

export function SubagentTaskStatus({ status, label }: { status: AgentStatus; label?: string }) {
  const running = status.activity === "working" || status.activity === "launching";
  const completed = status.activity === "done";
  const failed = status.activity === "failed";
  const statusLabel =
    label ?? (status.activity === "working" ? "Running" : completed ? "Completed" : status.label);
  return (
    <Badge
      variant={failed ? "destructive" : "secondary"}
      role="status"
      aria-label={statusLabel}
      aria-description={status.details}
      className={cn(
        "w-fit text-xs font-normal",
        running && "bg-session-active/10 text-session-active",
        completed && "bg-success/10 text-success",
        status.activity === "awaiting" && "bg-warning/10 text-warning",
      )}
    >
      {running && <RunningDot className="text-inherit" />}
      {completed && <CheckIcon aria-hidden="true" className="size-3.5" />}
      {failed && <CircleAlertIcon aria-hidden="true" className="size-3.5" />}
      {!running &&
        !completed &&
        !failed &&
        (status.activity === "awaiting" ? (
          <CircleAlertIcon aria-hidden="true" />
        ) : status.activity === "disconnected" ? (
          <UnplugIcon aria-hidden="true" />
        ) : status.activity === "other" ? (
          <ClockIcon aria-hidden="true" />
        ) : (
          <CircleIcon aria-hidden="true" />
        ))}
      <span className="resource-status-text">{statusLabel}</span>
    </Badge>
  );
}

export function SubagentTaskRow({
  searchItemIds,
  agentName,
  description,
  status,
  action,
  preview,
  children,
  keepSummaryWhenExpanded,
  execution,
}: {
  searchItemIds?: readonly string[];
  agentName: string;
  description: string;
  status: AgentStatus;
  action?: ReactNode;
  preview?: string;
  children?: ReactNode;
  keepSummaryWhenExpanded?: boolean;
  execution?: { model: string; effort: string | null };
}) {
  const label = formatSubagentTask(description);
  const executionLabel = execution
    ? [formatStatusModelLabel(execution.model), formatStatusEffortLabel(execution.effort)]
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <ActivityRow
      entry
      entryLabel={`${agentName} task`}
      searchItemIds={searchItemIds}
      presentation="message"
      keepSummaryWhenExpanded={keepSummaryWhenExpanded}
      icon={<BotIcon aria-hidden="true" className="size-3.5" />}
      title={
        <>
          <strong className="shrink-0 font-semibold">{agentName}</strong>{" "}
          <span className="truncate">· {label}</span>
          {executionLabel && (
            <span
              className="min-w-0 max-w-[45%] shrink truncate text-xs font-normal text-muted-foreground"
              title={executionLabel}
              data-testid="agent-execution"
            >
              {executionLabel}
            </span>
          )}
        </>
      }
      preview={preview}
      status={<SubagentTaskStatus status={status} />}
      actions={action}
      summary={preview ?? label}
    >
      {children}
    </ActivityRow>
  );
}
