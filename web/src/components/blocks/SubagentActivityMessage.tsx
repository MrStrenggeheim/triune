// Modified for Triune.
import { useContext } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { MessageCircleIcon, WorkflowIcon } from "lucide-react";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { Button } from "@/components/ui/button";
import { FilePathAwareMessageResponse } from "@/components/blocks/ChatMarkdown";
import { useChildSessions } from "@/hooks/useChildSessions";
import { Link, useLocation, useNavigate } from "@/lib/routing";
import { sessionNavigationSearch } from "@/lib/sessionNavigation";
import {
  readSubagentActivity,
  subagentEventStatus,
  subagentName,
  recordedSubagentReturn,
  shouldRenderSubagentReply,
  subagentMatchesChild,
  shortTaskText,
  type SubagentActivity,
} from "@/lib/subagentActivity";
import { useConversationChatStore, useConversationChatVisible } from "@/workbench/ScopedChatStore";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";
import { SubagentTaskRow } from "./SubagentTaskRow";
import { SubagentReply } from "./SubagentReply";
import { childStatus, type AgentStatus } from "@/shell/subagentStatus";

export function SubagentActivityMessage({ data }: { data: Record<string, unknown> }) {
  const scoped = useContext(ConversationScopeContext);
  const useChatStore = useConversationChatStore();
  const ownerId = useChatStore((state) => state.conversationId);
  const conversationId = scoped ?? ownerId;
  const queryClient = useContext(QueryClientContext);
  const blocks = useChatStore((state) => state.blocks);
  const activity = readSubagentActivity(data);
  if (!activity) return null;
  const ownerBlocks = ownerId === conversationId ? blocks : [];
  const completion = recordedSubagentReturn(activity, ownerBlocks);
  if (
    activity.phase === "returned" &&
    !shouldRenderSubagentReply(activity, ownerBlocks, conversationId)
  )
    return null;
  const status = completion
    ? subagentEventStatus(completion)
    : ["completed", "failed", "cancelled", "killed", "stopped"].includes(activity.status ?? "")
      ? subagentEventStatus(activity)
      : undefined;
  return queryClient && conversationId && activity.phase === "delegated" ? (
    <RecordedTask activity={activity} conversationId={conversationId} status={status} />
  ) : (
    <Task activity={activity} conversationId={conversationId} status={status} />
  );
}

function RecordedTask({
  activity,
  conversationId,
  status,
}: {
  activity: SubagentActivity;
  conversationId: string;
  status?: AgentStatus;
}) {
  const visible = useConversationChatVisible();
  const { children } = useChildSessions(conversationId, undefined, { enabled: visible });
  const child = children.find((candidate) => candidate.id === activity.sessionId);
  const matchesTask = !!child && subagentMatchesChild(activity, child);
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
      agentName={activity.agentName ?? (child && matchesTask ? subagentName(child) : undefined)}
      status={
        status ??
        (activity.phase === "delegated" && child && hasCurrentState && matchesTask
          ? childStatus(child)
          : undefined)
      }
    />
  );
}

function Task({
  activity,
  conversationId,
  agentName,
  status,
}: {
  activity: SubagentActivity;
  conversationId: string | null;
  agentName?: string;
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
  const name = agentName ?? activity.agentName ?? activity.agentRole ?? "Agent";
  const task = activity.taskDescription;
  const input = activity.taskInput;
  const action = (
    <>
      <Button variant="ghost" size="icon-xs" aria-label={`Open ${name} chat beside`} asChild>
        <Link
          to={{ pathname: `/c/${encodeURIComponent(activity.sessionId)}`, search: "" }}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            if (workbench) {
              event.preventDefault();
              workbench.openView(
                { kind: "conversation", conversationId: activity.sessionId, title: name },
                { beside: true },
              );
            }
          }}
        >
          <MessageCircleIcon aria-hidden="true" className="size-3.5" />
        </Link>
      </Button>
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
              workbench.openView(
                {
                  kind: "activity",
                  source: { kind: "chat", conversationId: origin },
                  focusAgentId: activity.sessionId,
                },
                { beside: true },
              );
            else navigate(to);
          }}
        >
          <WorkflowIcon aria-hidden="true" className="size-3.5" />
        </Link>
      </Button>
    </>
  );
  if (activity.phase === "returned")
    return (
      <SubagentReply
        activity={activity}
        conversationId={conversationId}
        agentName={name}
        action={action}
      />
    );
  return (
    <div
      className="not-prose w-full min-w-0 text-sm"
      data-testid="subagent-activity"
      data-phase={activity.phase}
      data-child-session-id={activity.sessionId}
    >
      <SubagentTaskRow
        agentName={name}
        description={task ? shortTaskText(task, 80) : "Delegated task"}
        status={status ?? subagentEventStatus(activity)}
        action={action}
        preview={input ? shortTaskText(input.split("\n", 1)[0], 180) : "Delegated task"}
      >
        {input ? (
          <div className="group space-y-2 py-1 text-sm">
            <ConversationScopeContext.Provider
              value={activity.taskInputRef?.conversationId ?? conversationId}
            >
              <FilePathAwareMessageResponse
                sourceItemId={activity.taskInputRef?.itemId ?? activity.itemId}
                breaks
                mode="static"
              >
                {input}
              </FilePathAwareMessageResponse>
            </ConversationScopeContext.Provider>
          </div>
        ) : undefined}
      </SubagentTaskRow>
    </div>
  );
}
