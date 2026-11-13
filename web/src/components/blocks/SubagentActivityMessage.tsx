// Modified for Triune.
import { useContext } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { SquareArrowOutUpRightIcon } from "lucide-react";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { Button } from "@/components/ui/button";
import { useChildSessions } from "@/hooks/useChildSessions";
import { Link, useLocation, useNavigate } from "@/lib/routing";
import { sessionNavigationSearch } from "@/lib/sessionNavigation";
import {
  readSubagentActivity,
  subagentEventStatus,
  subagentName,
  subagentTaskDescription,
  type SubagentActivity,
} from "@/lib/subagentActivity";
import { useConversationChatStore, useConversationChatVisible } from "@/workbench/ScopedChatStore";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";
import { SubagentTaskRow } from "./SubagentTaskRow";
import { childStatus, type AgentStatus } from "@/shell/subagentStatus";

export function SubagentActivityMessage({ data }: { data: Record<string, unknown> }) {
  const scoped = useContext(ConversationScopeContext);
  const useChatStore = useConversationChatStore();
  const ownerId = useChatStore((state) => state.conversationId);
  const conversationId = scoped ?? ownerId;
  const queryClient = useContext(QueryClientContext);
  const activity = readSubagentActivity(data);
  if (!activity) return null;
  return queryClient && conversationId ? (
    <RecordedTask activity={activity} conversationId={conversationId} />
  ) : (
    <Task activity={activity} conversationId={conversationId} />
  );
}

function RecordedTask({
  activity,
  conversationId,
}: {
  activity: SubagentActivity;
  conversationId: string;
}) {
  const visible = useConversationChatVisible();
  const { children } = useChildSessions(conversationId, undefined, { enabled: visible });
  const child = children.find((candidate) => candidate.id === activity.sessionId);
  const currentDescription = child ? subagentTaskDescription(child) : null;
  const matchesTask = !activity.taskDescription || activity.taskDescription === currentDescription;
  const hasCurrentState =
    child &&
    (child.busy ||
      child.current_task_status ||
      child.pending_elicitations_count > 0 ||
      child.last_task_error);
  return (
    <Task
      activity={activity}
      conversationId={conversationId}
      agentName={child ? subagentName(child) : undefined}
      description={
        activity.phase === "delegated" && child ? (currentDescription ?? undefined) : undefined
      }
      status={
        activity.phase === "delegated" && child && hasCurrentState && matchesTask
          ? childStatus(child)
          : undefined
      }
    />
  );
}

function Task({
  activity,
  conversationId,
  agentName,
  description,
  status,
}: {
  activity: SubagentActivity;
  conversationId: string | null;
  agentName?: string;
  description?: string;
  status?: AgentStatus;
}) {
  const workbench = useWorkbenchActions();
  const { search, pathname } = useLocation();
  const navigate = useNavigate();
  const origin = conversationId ?? decodeURIComponent(pathname.match(/^\/c\/([^/]+)/)?.[1] ?? "");
  const params = new URLSearchParams(sessionNavigationSearch(search));
  params.set("panel", "activity");
  params.set("focusAgentId", activity.sessionId);
  const to = { pathname: `/c/${encodeURIComponent(origin)}`, search: `?${params.toString()}` };
  const name = agentName ?? activity.agentName ?? "Agent";
  return (
    <div
      className="not-prose w-full min-w-0 text-sm"
      data-testid="subagent-activity"
      data-phase={activity.phase}
      data-child-session-id={activity.sessionId}
    >
      <SubagentTaskRow
        agentName={name}
        description={
          activity.taskDescription ??
          description ??
          (activity.phase === "delegated" ? "Delegated task" : "Result returned")
        }
        status={status ?? subagentEventStatus(activity)}
        action={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Inspect ${name} in Orchestration`}
            asChild
          >
            <Link
              to={to}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                if (workbench && origin)
                  workbench.openView({
                    kind: "activity",
                    source: { kind: "chat", conversationId: origin },
                    focusAgentId: activity.sessionId,
                  });
                else navigate(to);
              }}
            >
              <SquareArrowOutUpRightIcon aria-hidden="true" className="size-3.5" />
            </Link>
          </Button>
        }
      />
    </div>
  );
}
