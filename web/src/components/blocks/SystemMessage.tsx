// Modified for Triune.
import type { ReactNode } from "react";
import { FilePathAwareMessageResponse } from "@/components/blocks/ChatMarkdown";
import { ActivityRow } from "@/components/ActivityRow";
import {
  AlertCircleIcon,
  BanIcon,
  BellIcon,
  CheckCircle2Icon,
  InfoIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import type { ParsedSystemMessage, SystemMessageKind } from "@/lib/systemMessage";

const KIND_ICON: Record<Exclude<SystemMessageKind, "subagent_wake">, LucideIcon> = {
  task_completed: CheckCircle2Icon,
  task_failed: AlertCircleIcon,
  task_cancelled: BanIcon,
  timer_fired: BellIcon,
  terminal_idle: TerminalIcon,
  interrupted: BanIcon,
  generic: InfoIcon,
};

interface SystemMessageViewProps {
  message: ParsedSystemMessage;
  source?: ReactNode;
  sourceItemId?: string;
  children?: ReactNode;
}

/** Runtime notices use the same compact disclosure as other activity cards. */
export function SystemMessageView({
  message,
  source,
  sourceItemId,
  children,
}: SystemMessageViewProps) {
  if (message.kind === "subagent_wake") return null;
  const Icon = KIND_ICON[message.kind];
  const hasBody = message.body.trim().length > 0;
  const excerpt = message.body
    .trimStart()
    .slice(0, 768)
    .replace(/[\uD800-\uDBFF]$/u, "")
    .split(/\r?\n/, 1)[0]
    .replace(/\s+/g, " ")
    .trim();
  return (
    <div className="min-w-0 text-sm" data-testid="system-message" data-system-kind={message.kind}>
      <ActivityRow
        presentation="message"
        icon={<Icon aria-hidden="true" />}
        title={
          <>
            <strong className="shrink-0 font-semibold">System</strong>
            {source}
          </>
        }
        summary={excerpt || message.label}
      >
        {children ??
          (hasBody ? (
            <FilePathAwareMessageResponse
              sourceItemId={sourceItemId}
              breaks
              mode="static"
              className="text-sm leading-5 [&>*]:my-0 [&_p]:my-1"
            >
              {message.body}
            </FilePathAwareMessageResponse>
          ) : undefined)}
      </ActivityRow>
    </div>
  );
}
