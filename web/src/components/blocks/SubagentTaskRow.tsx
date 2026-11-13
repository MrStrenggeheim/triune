// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ReactNode } from "react";
import { BotIcon, CheckIcon, CircleAlertIcon } from "lucide-react";
import { ActivityRow } from "@/components/ActivityRow";
import { RunningDot } from "@/components/RunningDot";
import type { AgentStatus } from "@/shell/subagentStatus";
import { cn } from "@/lib/utils";

export function SubagentTaskStatus({ status }: { status: AgentStatus }) {
  const running = status.activity === "working" || status.activity === "launching";
  const completed = status.activity === "done";
  const failed = status.activity === "failed";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-xs",
        completed && "text-success",
        failed && "text-destructive",
      )}
    >
      {running && <RunningDot />}
      {completed && <CheckIcon aria-hidden="true" className="size-3.5" />}
      {failed && <CircleAlertIcon aria-hidden="true" className="size-3.5" />}
      {status.activity === "working" ? "Running" : completed ? "Completed" : status.label}
    </span>
  );
}

export function SubagentTaskRow({
  agentName,
  description,
  status,
  action,
  preview,
  children,
}: {
  agentName: string;
  description: string;
  status: AgentStatus;
  action?: ReactNode;
  preview?: string;
  children?: ReactNode;
}) {
  return (
    <div className="border-l-2 border-primary/60 pl-2 [&_.activity-row>p]:line-clamp-1">
      <ActivityRow
        icon={<BotIcon aria-hidden="true" className="size-3.5" />}
        title={
          <>
            <strong className="font-semibold">{agentName}</strong>: {description}
          </>
        }
        preview={preview}
        status={
          <span className="flex items-center gap-2">
            <SubagentTaskStatus status={status} />
            {action}
          </span>
        }
      >
        {children}
      </ActivityRow>
    </div>
  );
}
