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

export function SubagentTaskStatus({ status, label }: { status: AgentStatus; label?: string }) {
  const running = status.activity === "working" || status.activity === "launching";
  const completed = status.activity === "done";
  const failed = status.activity === "failed";
  return (
    <Badge
      variant={failed ? "destructive" : "secondary"}
      aria-description={status.details}
      className={cn(
        "w-fit text-xs font-normal",
        running && "bg-session-active/10 text-session-active",
        completed && "bg-success/10 text-success",
        status.activity === "awaiting" && "bg-warning/10 text-warning",
      )}
    >
      {running && <RunningDot />}
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
      {label ??
        (status.activity === "working" ? "Running" : completed ? "Completed" : status.label)}
    </Badge>
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
