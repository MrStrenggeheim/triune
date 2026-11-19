// Modified for Triune.
import { useAgentPresentation } from "@/hooks/useAgentPresentation";
import { useContext } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { ActivityNavigation } from "@/components/ActivityNavigation";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { FilePathAwareMessageResponse } from "@/components/blocks/ChatMarkdown";
import { useChildSessions } from "@/hooks/useChildSessions";
import { useLocation } from "@/lib/routing";
import { sessionNavigationSearch } from "@/lib/sessionNavigation";
import {
  subagentCardItemIds,
  readSubagentActivity,
  subagentEventStatus,
  recordedSubagentReturn,
  shouldRenderSubagentReply,
  shortTaskText,
  subagentCardMessages,
  type SubagentActivity,
} from "@/lib/subagentActivity";
import { useConversationChatStore, useConversationChatVisible } from "@/workbench/ScopedChatStore";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";
import { SubagentTaskRow } from "./SubagentTaskRow";
import { SubagentReply, SubagentReportContent } from "./SubagentReply";
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
  const resource = data.resource as Record<string, unknown> | undefined;
  const canonical = Array.isArray(resource?.card_dispatches);
  const completion = canonical ? undefined : recordedSubagentReturn(activity, ownerBlocks);
  if (
    activity.phase === "returned" &&
    !shouldRenderSubagentReply(activity, ownerBlocks, conversationId)
  )
    return null;
  const status = canonical
    ? resource?.card_phase === "delegated" && !resource?.card_status
      ? undefined
      : subagentEventStatus({
          ...activity,
          status: typeof resource?.card_status === "string" ? resource.card_status : null,
          phase: resource?.card_phase === "returned" ? "returned" : "delegated",
        })
    : completion
      ? subagentEventStatus(completion)
      : ["completed", "failed", "cancelled", "killed", "stopped"].includes(activity.status ?? "")
        ? subagentEventStatus(activity)
        : undefined;
  return queryClient && conversationId ? (
    <RecordedTask data={data} activity={activity} conversationId={conversationId} status={status} />
  ) : (
    <Task data={data} activity={activity} conversationId={conversationId} status={status} />
  );
}

function RecordedTask({
  data,
  activity,
  conversationId,
  status,
}: {
  data: Record<string, unknown>;
  activity: SubagentActivity;
  conversationId: string;
  status?: AgentStatus;
}) {
  const visible = useConversationChatVisible();
  const resource = data.resource as Record<string, unknown> | undefined;
  const { children } = useChildSessions(conversationId, {
    enabled: visible,
    reconcile: true,
    dispatchId:
      typeof resource?.card_dispatch_id === "string"
        ? resource.card_dispatch_id
        : (activity.dispatchId ?? undefined),
    unresolvedChild:
      !status || status.label === "Status unavailable" ? activity.sessionId : undefined,
  });
  const child = children.find((candidate) => candidate.id === activity.sessionId);
  const canonical = Array.isArray(resource?.card_dispatches);
  const hasCurrentState =
    child &&
    (child.busy ||
      child.current_task_status ||
      child.pending_elicitations_count > 0 ||
      child.last_task_error);
  return (
    <Task
      data={data}
      activity={activity}
      conversationId={conversationId}
      status={
        canonical && child && hasCurrentState
          ? childStatus(child)
          : (status ??
            (activity.phase === "delegated" && child && hasCurrentState
              ? childStatus(child)
              : undefined))
      }
    />
  );
}

function Task({
  data,
  activity,
  conversationId,
  status,
}: {
  data: Record<string, unknown>;
  activity: SubagentActivity;
  conversationId: string | null;
  status?: AgentStatus;
}) {
  const workbench = useWorkbenchActions();
  const { search, pathname } = useLocation();
  const origin = conversationId ?? decodeURIComponent(pathname.match(/^\/c\/([^/]+)/)?.[1] ?? "");
  const params = new URLSearchParams(sessionNavigationSearch(search));
  params.set("panel", "activity");
  params.set("focusAgentId", activity.sessionId);
  const to = { pathname: `/c/${encodeURIComponent(origin)}`, search: `?${params.toString()}` };
  const display = useAgentPresentation(activity.sessionId, conversationId, {
    data,
    activity,
  });
  const name = display.name;
  const resource = data.resource as Record<string, unknown> | undefined;
  const canonical = Array.isArray(resource?.card_dispatches);
  const messages = canonical ? subagentCardMessages(data) : [];
  const task = display.task;
  const input = activity.taskInput;
  const preview = display.preview ?? "No captured message";
  const action = (
    <ActivityNavigation
      name={name}
      openHref={`/c/${encodeURIComponent(activity.sessionId)}`}
      orchestrationHref={to.pathname + to.search}
      onOpen={
        workbench
          ? () =>
              workbench.openView(
                { kind: "conversation", conversationId: activity.sessionId, title: name },
                { beside: true },
              )
          : undefined
      }
      onOrchestration={
        workbench && origin
          ? () =>
              workbench.openView(
                {
                  kind: "activity",
                  conversationId: origin,
                  source: { kind: "chat", conversationId: origin },
                  focusAgentId: activity.sessionId,
                  linkRequestId: crypto.randomUUID(),
                },
                { beside: true },
              )
          : undefined
      }
    />
  );
  if (!canonical && activity.phase === "returned")
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
      className="subagent-activity-card not-prose w-full min-w-0 text-sm"
      data-testid="subagent-activity"
      data-phase={activity.phase}
      data-child-session-id={activity.sessionId}
      data-message-id={activity.itemId}
      data-message-aliases={JSON.stringify(subagentCardItemIds(data))}
    >
      <SubagentTaskRow
        searchItemIds={subagentCardItemIds(data)}
        agentName={name}
        execution={activity.execution}
        description={task ? shortTaskText(task, 80) : "Delegated task"}
        status={status ?? subagentEventStatus(activity)}
        action={action}
        preview={preview || "Delegated task"}
      >
        {canonical ? (
          messages.length > 0 ? (
            <div className="space-y-3 py-1 text-sm">
              {Array.from(new Set(messages.map((message) => message.activity.dispatchId))).map(
                (dispatchId) => (
                  <section
                    key={dispatchId ?? "unknown"}
                    className="space-y-2"
                    aria-label={dispatchId ? `Dispatch ${dispatchId}` : "Captured messages"}
                  >
                    {messages
                      .filter((message) => message.activity.dispatchId === dispatchId)
                      .map((message) => (
                        <div
                          key={`${message.direction}:${message.activity.itemId}:${message.activity.turnId}`}
                          data-search-item-id={message.activity.itemId}
                        >
                          <div className="text-xs text-muted-foreground">{message.direction}</div>
                          {message.direction === "Reply" ? (
                            <SubagentReportContent
                              activity={message.activity}
                              conversationId={conversationId}
                              shownText={message.text}
                            />
                          ) : (
                            <ConversationScopeContext.Provider
                              value={
                                message.activity.taskInputRef?.conversationId ?? conversationId
                              }
                            >
                              <FilePathAwareMessageResponse
                                sourceItemId={
                                  message.activity.taskInputRef?.itemId ?? message.activity.itemId
                                }
                                breaks
                                mode="static"
                              >
                                {message.text}
                              </FilePathAwareMessageResponse>
                            </ConversationScopeContext.Provider>
                          )}
                        </div>
                      ))}
                  </section>
                ),
              )}
            </div>
          ) : undefined
        ) : input ? (
          <div className="group space-y-2 py-1 text-sm" data-search-item-id={activity.itemId}>
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
