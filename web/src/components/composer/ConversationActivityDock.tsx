import { useConversationChatVisible } from "@/workbench/ScopedChatStore";
import { useEffect, useId, useState } from "react";
import { BotIcon, ChevronDownIcon, ChevronRightIcon, TerminalIcon } from "lucide-react";
import { ActivityRow } from "@/components/ActivityRow";
import { PeerMessage } from "@/components/blocks/PeerMessage";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { Button } from "@/components/ui/button";
import { useChatActivity, type ChatActivityEntry } from "@/hooks/useChatActivity";
import { useChildSessions, type ChildSessionInfo } from "@/hooks/useChildSessions";
import {
  peerActivityKey,
  useActivityConversationState,
  usePeerMessages,
  type PeerActivityMessage,
} from "@/hooks/usePeerMessages";
import { useActivityAttention } from "@/lib/activityAttention";
import { Link } from "@/lib/routing";
import type { ConversationState } from "@/store/chatStore";
import { childStatus } from "@/shell/subagentStatus";

interface DockActivityItem {
  id: string;
  revision: string;
  title: string;
  status: string;
  preview?: string;
  kind: "agent" | "shell" | "message";
  conversationId: string;
  running: boolean;
  attention: boolean;
  unread: boolean;
  message?: PeerActivityMessage;
}

/** Revisions distinguish a new result from a background refresh of the same result. */
export function conversationActivityItems(
  conversationId: string,
  state: ConversationState,
  children: ChildSessionInfo[],
  shells: ChatActivityEntry[],
  messages: PeerActivityMessage[],
): DockActivityItem[] {
  const items: DockActivityItem[] = [];
  const approvals = state.blocks.filter(
    (block) => block.type === "elicitation" && block.status === "pending",
  );
  const working = ["running", "launching", "waiting"].includes(state.sessionStatus);
  if (working || approvals.length || state.blockedOn || state.sessionStatus === "failed") {
    const attention = !!(approvals.length || state.blockedOn || state.sessionStatus === "failed");
    items.push({
      id: `conversation:${conversationId}`,
      revision: JSON.stringify([
        state.sessionStatus,
        state.blockedOn,
        approvals.map((block) => (block.type === "elicitation" ? block.elicitationId : "")),
      ]),
      kind: "agent",
      title: "This conversation",
      status: attention
        ? "Needs attention"
        : state.sessionStatus === "launching"
          ? "Launching"
          : "Working",
      preview: state.blockedOn ?? undefined,
      conversationId,
      running: working,
      attention,
      unread: false,
    });
  }
  for (const child of children) {
    const status = childStatus(child);
    const running = status.activity === "working" || status.activity === "launching";
    const attention = ["awaiting", "failed", "disconnected"].includes(status.activity);
    const unread = status.activity === "done" && !!child.last_message_preview;
    if (!running && !attention && !unread) continue;
    items.push({
      id: `child:${child.id}`,
      revision: JSON.stringify([
        child.current_task_status,
        child.pending_elicitations_count,
        child.last_message_preview,
        child.last_task_error,
      ]),
      kind: "agent",
      title: child.task_summary || child.session_name || child.title || "Agent",
      status: status.label,
      preview: child.last_message_preview ?? undefined,
      conversationId: child.id,
      running,
      attention,
      unread,
    });
  }
  const runningShells = shells.filter((shell) => shell.state === "running");
  // A live terminal already summarizes its command rows.
  const terminals = new Set(
    runningShells
      .filter((shell) => shell.kind === "terminal")
      .map((shell) => JSON.stringify([shell.session_id, shell.terminal_id])),
  );
  for (const shell of runningShells) {
    if (
      shell.kind === "command" &&
      terminals.has(JSON.stringify([shell.session_id, shell.terminal_id]))
    )
      continue;
    items.push({
      id: `shell:${shell.session_id}:${shell.id}`,
      revision: String(shell.started_at ?? shell.id),
      kind: "shell",
      title: shell.name,
      status: "Running",
      conversationId: shell.session_id,
      running: true,
      attention: false,
      unread: false,
    });
  }
  for (const task of state.backgroundTasks) {
    if (task.status && !["running", "in_progress", "queued", "pending"].includes(task.status))
      continue;
    if (
      task.id &&
      runningShells.some((shell) => shell.id === task.id || shell.terminal_id === task.id)
    )
      continue;
    items.push({
      id: `background:${task.id ?? JSON.stringify([task.command, task.description])}`,
      revision: task.status ?? "running",
      kind: "shell",
      title: task.description || task.command || "Background shell",
      status: task.status || "Running",
      conversationId,
      running: true,
      attention: false,
      unread: false,
    });
  }
  if (!state.backgroundTasks.length && !runningShells.length && state.backgroundTaskCount > 0)
    items.push({
      id: "background-count",
      revision: String(state.backgroundTaskCount),
      kind: "shell",
      title: `${state.backgroundTaskCount} background tasks`,
      status: "Running",
      conversationId,
      running: true,
      attention: false,
      unread: false,
    });
  for (const message of messages) {
    const incoming = message.direction === "incoming";
    const attention =
      !incoming && ["failed", "unknown"].includes(message.communication.delivery_state);
    if (!incoming && !attention) continue;
    items.push({
      id: `message:${peerActivityKey(message)}`,
      revision: incoming ? message.communication.message_id : message.communication.delivery_state,
      kind: "message",
      title: incoming
        ? `From ${message.communication.source_title || message.communication.source_agent_id || "Agent"}`
        : `To ${message.communication.destination_conversation_id}`,
      status:
        message.communication.delivery_state === "unknown"
          ? "Unconfirmed"
          : message.communication.delivery_state,
      conversationId: incoming
        ? message.communication.source_conversation_id || conversationId
        : message.communication.destination_conversation_id,
      running: false,
      attention,
      unread: incoming,
      message,
    });
  }
  return items;
}

export function ConversationActivityDock({ conversationId }: { conversationId: string | null }) {
  const attention = useActivityAttention(conversationId);
  return (
    <ActivityDockContent
      key={attention.scopeKey ?? "unresolved"}
      conversationId={conversationId}
      attention={attention}
    />
  );
}

function ActivityDockContent({
  conversationId,
  attention,
}: {
  conversationId: string | null;
  attention: ReturnType<typeof useActivityAttention>;
}) {
  const scopedId = attention.scopeKey ? conversationId : null;
  const state = useActivityConversationState(scopedId);
  const chatVisible = useConversationChatVisible();
  const children = useChildSessions(scopedId, { enabled: chatVisible, reconcile: true });
  const shells = useChatActivity(scopedId);
  const peers = usePeerMessages(scopedId);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const items = scopedId
    ? conversationActivityItems(
        scopedId,
        state,
        children.children,
        shells.data?.data ?? [],
        peers.messages,
      )
    : [];
  const visible = items.filter(
    (item) =>
      item.running ||
      (item.attention && attention.disposition(item.id, item.revision) !== "dismissed") ||
      (item.unread && !attention.disposition(item.id, item.revision)),
  );
  useEffect(() => {
    if (!visible.length) setExpanded(false);
  }, [visible.length]);
  if (!visible.length) return null;
  const running = visible.filter((item) => item.running).length;
  const needsAttention = visible.filter(
    (item) => item.attention && attention.disposition(item.id, item.revision) !== "dismissed",
  ).length;
  const unread = visible.filter(
    (item) => item.unread && !attention.disposition(item.id, item.revision),
  );
  const summary = [
    running ? `${running} running` : null,
    needsAttention ? `${needsAttention} need attention` : null,
    unread.length ? `${unread.length} unread` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section
      aria-label="Conversation activity"
      className="min-w-0 border-t border-border text-sm"
      data-testid="conversation-activity-dock"
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-full justify-start gap-1.5 px-2 font-normal"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDownIcon className="size-3.5" />
        ) : (
          <ChevronRightIcon className="size-3.5" />
        )}
        <span>Activity · {summary}</span>
      </Button>
      {expanded && (
        <div id={id} className="max-h-64 overflow-y-auto overscroll-contain px-2 pb-1">
          {attention.error && (
            <p role="status" className="text-xs text-muted-foreground">
              Attention changes could not be saved: {attention.error.message}
            </p>
          )}
          {(children.error || shells.error || peers.error) && (
            <p role="status" className="text-xs text-muted-foreground">
              Some activity could not be refreshed; showing the last available records.
            </p>
          )}
          {unread.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => attention.markRead(unread)}>
              Mark results read
            </Button>
          )}
          {needsAttention > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => attention.dismiss(visible.filter((item) => item.attention))}
            >
              Dismiss attention
            </Button>
          )}
          {visible.map((item) => (
            <div key={item.id} className="border-b border-border/50 last:border-b-0">
              {item.message ? (
                <ConversationScopeContext.Provider value={scopedId}>
                  <PeerMessage
                    communication={item.message.communication}
                    content={item.message.content}
                    itemId={item.message.id}
                  />
                </ConversationScopeContext.Provider>
              ) : (
                <ActivityRow
                  icon={
                    item.kind === "shell" ? (
                      <TerminalIcon className="size-3.5" />
                    ) : (
                      <BotIcon className="size-3.5" />
                    )
                  }
                  title={
                    <Link to={`/c/${encodeURIComponent(item.conversationId)}`}>{item.title}</Link>
                  }
                  status={item.status}
                  preview={item.preview}
                >
                  {item.preview && (
                    <p className="whitespace-pre-wrap break-words">{item.preview}</p>
                  )}
                  <Link
                    to={`/c/${encodeURIComponent(item.conversationId)}`}
                    className="text-xs underline"
                  >
                    Open conversation
                  </Link>
                </ActivityRow>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
