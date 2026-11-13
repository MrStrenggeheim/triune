// Modified for Triune.
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { BotIcon, EllipsisIcon, InfoIcon, TerminalIcon } from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip";
import { SubagentTaskStatus } from "@/components/blocks/SubagentTaskRow";
import { PeerMessage } from "@/components/blocks/PeerMessage";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useChatActivity, type ChatActivityEntry } from "@/hooks/useChatActivity";
import { useChildSessionTree, type ChildSessionInfo } from "@/hooks/useChildSessions";
import { useSession } from "@/hooks/useSession";
import { peerActivityKey, usePeerMessages } from "@/hooks/usePeerMessages";
import { subagentName, subagentTaskDescription } from "@/lib/subagentActivity";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";
import { Link } from "@/lib/routing";
import { childStatus, sessionStatus, type AgentStatus } from "./subagentStatus";
import type { AgentsViewMode } from "./SubagentsPanel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SubagentsGraphView = lazy(() =>
  import("./SubagentsGraphView").then((module) => ({ default: module.SubagentsGraphView })),
);

export interface ChatActivityTerminalTarget {
  sessionId: string;
  terminalId: string;
  workspaceId?: string;
}

export interface ChatActivityPanelProps {
  conversationId: string;
  rootSessionId: string;
  active?: boolean;
  focusAgentId?: string;
  linkRequestId?: string;
  sourceControl?: ReactNode;
  /** Open this exact existing resource, even when it belongs to another chat. */
  onOpenTerminal?: (target: ChatActivityTerminalTarget) => void;
}

type ActivityFilter = "All" | "Agents" | "Messages" | "Shells";
interface ShellGroup {
  id: string;
  terminal?: ChatActivityEntry;
  commands: ChatActivityEntry[];
}

function shellGroups(entries: ChatActivityEntry[]): ShellGroup[] {
  const groups = new Map<string, ShellGroup>();
  const terminals = entries.filter((entry) => entry.kind === "terminal");
  for (const terminal of terminals) {
    // Resource IDs can be reused after exit; the activity ID identifies the launch.
    const id = JSON.stringify([terminal.session_id, terminal.id]);
    groups.set(id, { id, terminal, commands: [] });
  }
  for (const entry of entries.filter((candidate) => candidate.kind === "command")) {
    const candidates = entry.terminal_id
      ? terminals.filter(
          (terminal) =>
            terminal.session_id === entry.session_id && terminal.terminal_id === entry.terminal_id,
        )
      : [];
    const matches =
      candidates.length <= 1
        ? candidates
        : candidates.filter((terminal) => {
            const started = timestamp(entry.started_at);
            const launch = timestamp(terminal.started_at);
            const ended = timestamp(terminal.ended_at);
            return (
              started != null &&
              launch != null &&
              started >= launch &&
              (ended == null || started <= ended)
            );
          });
    const terminal = matches.length === 1 ? matches[0] : undefined;
    // Ambiguous and bare commands stay grouped without inventing a terminal launch.
    const id = terminal
      ? JSON.stringify([terminal.session_id, terminal.id])
      : entry.terminal_id
        ? JSON.stringify(["commands", entry.session_id, entry.terminal_id])
        : "commands";
    let group = groups.get(id);
    if (!group) {
      group = { id, commands: [] };
      groups.set(id, group);
    }
    group.commands.push(entry);
  }
  return [...groups.values()];
}

function timestamp(value: ChatActivityEntry["started_at"]): number | undefined {
  if (value == null) return undefined;
  const result = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

function displayTime(value: string | number): string {
  const time = timestamp(value);
  return time == null ? String(value) : new Date(time).toLocaleString();
}

function isLive(entry: ChatActivityEntry) {
  return entry.state === "running" || entry.state === "idle";
}

function groupState(group: ShellGroup): ChatActivityEntry["state"] {
  if (group.terminal) return group.terminal.state;
  if (group.commands.some(isLive)) return "running";
  if (group.commands.some((entry) => entry.state === "disconnected")) return "disconnected";
  if (group.commands.some((entry) => entry.state === "unknown")) return "unknown";
  return "exited";
}

function groupName(group: ShellGroup) {
  return (
    group.terminal?.name ??
    (group.id === "commands" ? "Commands without a terminal" : "Recorded shell commands")
  );
}

const STATE_LABELS: Record<ChatActivityEntry["state"], string> = {
  running: "Running",
  idle: "Idle · shell open",
  exited: "Exited",
  disconnected: "Disconnected · availability unknown",
  unknown: "State unknown",
};

function groupLastActive(group: ShellGroup): number {
  return Math.max(
    0,
    ...[...(group.terminal ? [group.terminal] : []), ...group.commands].flatMap((entry) => [
      timestamp(entry.started_at) ?? 0,
      timestamp(entry.ended_at) ?? 0,
    ]),
  );
}

function isActiveAgent(child: ChildSessionInfo) {
  return ["launching", "working", "awaiting"].includes(childStatus(child).activity);
}

export function ChatActivityPanel(props: ChatActivityPanelProps) {
  return <ChatActivityContent key={props.conversationId} {...props} />;
}

function ChatActivityContent({
  conversationId,
  rootSessionId,
  active = true,
  focusAgentId,
  linkRequestId,
  sourceControl,
  onOpenTerminal,
}: ChatActivityPanelProps) {
  const [filter, setFilter] = useState<ActivityFilter>("All");
  const [viewMode, setViewMode] = useState<AgentsViewMode>("list");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(focusAgentId ?? null);
  useEffect(() => {
    if (active && focusAgentId) setSelectedAgentId(focusAgentId);
  }, [active, focusAgentId, linkRequestId]);
  const agents = useChildSessionTree(rootSessionId, active);
  const activity = useChatActivity(conversationId, { enabled: active });
  const peers = usePeerMessages(conversationId, { enabled: active && filter === "Messages" });
  const groups = shellGroups(activity.data?.data ?? []);
  const selected = groups.find((group) => group.id === selectedGroupId);
  const rows = [
    ...agents.children.filter(isActiveAgent).map((child) => ({
      kind: "agent" as const,
      id: child.id,
      lastActive: (child.updated_at ?? child.created_at ?? 0) * 1000,
      child,
    })),
    ...groups
      .filter((group) => group.terminal && isLive(group.terminal))
      .map((group) => ({
        kind: "shell" as const,
        id: group.id,
        lastActive: groupLastActive(group),
        group,
      })),
  ]
    .filter(
      (row) =>
        filter === "All" ||
        (filter === "Agents" && row.kind === "agent") ||
        (filter === "Shells" && row.kind === "shell"),
    )
    .sort((left, right) => right.lastActive - left.lastActive || left.id.localeCompare(right.id));

  const renderShell = (group: ShellGroup) => (
    <ShellRow
      key={group.id}
      group={group}
      onOpenTerminal={onOpenTerminal}
      onInspect={() => {
        setDetailsOpen(false);
        setSelectedGroupId(group.id);
      }}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--workspace-content)]">
      <header className="workspace-control-header flex min-w-0 shrink-0 items-center gap-1 border-b bg-[var(--workspace-content)] px-2">
        {sourceControl ?? (
          <h2 className="min-w-0 truncate pl-1 font-medium text-ui">Orchestration</h2>
        )}
        <DropdownMenu open={active && optionsOpen} onOpenChange={setOptionsOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Orchestration options"
            >
              <EllipsisIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Show</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) => setFilter(value as ActivityFilter)}
            >
              {(["All", "Agents", "Messages", "Shells"] as const).map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {value}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={viewMode}
              onValueChange={(value) => {
                setViewMode(value as AgentsViewMode);
                if (filter === "Messages" || filter === "Shells") setFilter("Agents");
              }}
            >
              <DropdownMenuRadioItem value="list">List view</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="graph">Graph view</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDetailsOpen(true)}>Details</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(agents.error || activity.error) && (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            {agents.error ? "Could not refresh agents." : "Could not refresh shells."}
          </p>
        )}
        {activity.data?.warning && (
          <p role="status" className="px-3 text-xs">
            History incomplete
          </p>
        )}
        {filter !== "Messages" && (
          <>
            {viewMode === "graph" && filter !== "Shells" && active ? (
              <Suspense
                fallback={
                  <p role="status" className="p-3 text-sm">
                    Loading graph…
                  </p>
                }
              >
                <SubagentsGraphView conversationId={conversationId} rootSessionId={rootSessionId} />
              </Suspense>
            ) : (
              <ul aria-label="Orchestration" className="density-list flex flex-col px-2">
                {rows.map((row) =>
                  row.kind === "agent" ? (
                    <AgentRow
                      key={row.id}
                      child={row.child}
                      onInspect={() => setSelectedAgentId(row.id)}
                    />
                  ) : (
                    renderShell(row.group)
                  ),
                )}
              </ul>
            )}
            {rows.length === 0 && viewMode === "list" && (
              <p role="status" className="p-4 text-center text-sm text-muted-foreground">
                {agents.isLoading || activity.isLoading
                  ? "Loading orchestration…"
                  : "No active agents or open shells."}
              </p>
            )}
          </>
        )}
        {filter === "Messages" && (
          <section aria-label="Messages" className="p-2">
            {peers.isLoading && (
              <p role="status" className="p-2 text-sm">
                Loading messages…
              </p>
            )}
            {peers.error && (
              <p role="alert" className="p-2 text-sm text-destructive">
                Could not refresh messages.
              </p>
            )}
            {peers.messages.length === 0 && !peers.isLoading && (
              <p className="p-2 text-sm text-muted-foreground">No messages in loaded history.</p>
            )}
            <ul>
              {peers.messages.map((message) => (
                <li
                  key={peerActivityKey(message)}
                  className="border-b border-border/50 last:border-b-0"
                >
                  <ConversationScopeContext.Provider value={conversationId}>
                    <PeerMessage
                      communication={message.communication}
                      content={message.content}
                      itemId={message.id}
                    />
                  </ConversationScopeContext.Provider>
                </li>
              ))}
            </ul>
            {peers.hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                disabled={peers.isFetchingNextPage}
                onClick={() => void peers.fetchNextPage()}
              >
                Load older outgoing messages
              </Button>
            )}
          </section>
        )}
      </div>
      {active && detailsOpen && (
        <Dialog open onOpenChange={setDetailsOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Orchestration details</DialogTitle>
              <DialogDescription>
                Recorded agents and shell activity for this chat.
              </DialogDescription>
            </DialogHeader>
            {agents.error && (
              <p role="alert" className="text-sm text-destructive">
                {agents.error.message}
              </p>
            )}
            {activity.error && (
              <>
                <p role="alert" className="text-sm text-destructive">
                  {activity.error.message}
                </p>
                <Button variant="ghost" size="sm" onClick={() => void activity.refetch()}>
                  Retry shells
                </Button>
              </>
            )}
            {activity.data?.warning && <p className="text-sm">{activity.data.warning}</p>}
            {activity.data && activity.data.coverage !== "complete" && (
              <p className="text-xs text-muted-foreground">
                {typeof activity.data.coverage === "string"
                  ? `History coverage: ${activity.data.coverage || "unavailable"}. Older shell activity may not have been recorded.`
                  : `Up to ${activity.data.coverage.max_entries} retained entries; ${activity.data.coverage.max_output_bytes} bytes per output snapshot.`}
              </p>
            )}
            {typeof activity.data?.coverage === "object" &&
              activity.data.coverage.terminals === "unavailable" && (
                <p className="text-sm">Current terminal activity unavailable.</p>
              )}
            <ul aria-label="Recorded activity" className="density-list flex flex-col">
              {[...agents.children]
                .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
                .map((child) => (
                  <AgentRow
                    key={child.id}
                    child={child}
                    onInspect={() => {
                      setDetailsOpen(false);
                      setSelectedAgentId(child.id);
                    }}
                  />
                ))}
              {[...groups].sort((a, b) => groupLastActive(b) - groupLastActive(a)).map(renderShell)}
            </ul>
          </DialogContent>
        </Dialog>
      )}
      {active && selected && (
        <ShellOutputDialog group={selected} onClose={() => setSelectedGroupId(null)} />
      )}
      {active && selectedAgentId && (
        <AgentDetails
          agentId={selectedAgentId}
          child={agents.children.find((child) => child.id === selectedAgentId)}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  );
}

function AgentRow({ child, onInspect }: { child: ChildSessionInfo; onInspect: () => void }) {
  const status = childStatus(child);
  return (
    <li data-agent-id={child.id} className="border-b border-border/50 last:border-b-0">
      <TooltipButton
        className="density-row flex w-full min-w-0 items-center text-left hover:bg-[var(--workspace-hover-on-content)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onInspect}
      >
        <BotIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">
          <strong className="font-medium">{subagentName(child)}</strong>:{" "}
          {subagentTaskDescription(child) ?? status.label}
        </span>
        <SubagentTaskStatus status={status} />
      </TooltipButton>
    </li>
  );
}

function AgentDetails({
  agentId,
  child,
  onClose,
}: {
  agentId: string;
  child?: ChildSessionInfo;
  onClose: () => void;
}) {
  // Explicit inspection can resolve a completed target outside the overview/tree cache.
  const { session, isLoading, error } = useSession(child ? null : agentId);
  const workbench = useWorkbenchActions();
  const name = child
    ? subagentName(child)
    : (session?.subAgentName ?? session?.agentName ?? "Agent");
  const status: AgentStatus = child
    ? childStatus(child)
    : sessionStatus(session?.status, session?.lastTaskError);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>
            {child
              ? (subagentTaskDescription(child) ?? "No task description recorded.")
              : "Recorded agent details."}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p role="status">Loading agent…</p>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load this agent.
          </p>
        ) : (
          <SubagentTaskStatus status={status} />
        )}
        {child?.last_task_error && (
          <p className="whitespace-pre-wrap text-sm">{child.last_task_error.message}</p>
        )}
        <p className="break-all text-xs text-muted-foreground">Session: {agentId}</p>
        <Button variant="secondary" asChild>
          <Link
            to={`/c/${encodeURIComponent(agentId)}`}
            onClick={(event) => {
              if (
                !workbench ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              workbench.openConversation(agentId);
            }}
          >
            Open conversation
          </Link>
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function ShellRow({
  group,
  onOpenTerminal,
  onInspect,
}: {
  group: ShellGroup;
  onOpenTerminal?: ChatActivityPanelProps["onOpenTerminal"];
  onInspect: () => void;
}) {
  const terminal = group.terminal;
  const live = terminal && isLive(terminal);
  const target =
    live && terminal.terminal_id
      ? {
          sessionId: terminal.session_id,
          terminalId: terminal.terminal_id,
          ...(terminal.owner_kind === "workspace"
            ? { workspaceId: terminal.workspace_id ?? terminal.owner_id }
            : {}),
        }
      : undefined;
  const openTerminal = target && onOpenTerminal ? () => onOpenTerminal(target) : undefined;
  return (
    <li className="density-row flex min-w-0 items-center border-b border-border/50 last:border-b-0">
      <TerminalIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <TooltipButton
        className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
        onClick={openTerminal ?? onInspect}
      >
        {groupName(group)}
      </TooltipButton>
      <span className="shrink-0 text-xs text-muted-foreground">
        {STATE_LABELS[groupState(group)]}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Inspect ${groupName(group)}`}
        onClick={onInspect}
      >
        <InfoIcon className="size-3.5" />
      </Button>
    </li>
  );
}

function ShellOutputDialog({ group, onClose }: { group: ShellGroup; onClose: () => void }) {
  const entries = [...(group.terminal ? [group.terminal] : []), ...group.commands];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{groupName(group)}</DialogTitle>
          <DialogDescription>
            Retained output · {STATE_LABELS[groupState(group)]}. This view does not attach to a
            process.
          </DialogDescription>
        </DialogHeader>
        {entries.map((entry) => (
          <section key={entry.id} className="min-w-0 space-y-2">
            <h3 className="break-all font-mono text-sm font-medium">{entry.name}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
              <dt>State</dt>
              <dd>{STATE_LABELS[entry.state]}</dd>
              <dt>Session</dt>
              <dd className="break-all">{entry.session_id}</dd>
              {entry.parent_agent_id && (
                <>
                  <dt>Agent</dt>
                  <dd className="break-all">{entry.parent_agent_id}</dd>
                </>
              )}
              {entry.started_at != null && (
                <>
                  <dt>Started</dt>
                  <dd>{displayTime(entry.started_at)}</dd>
                </>
              )}
              {entry.ended_at != null && (
                <>
                  <dt>Ended</dt>
                  <dd>{displayTime(entry.ended_at)}</dd>
                </>
              )}
              <dt>Exit status</dt>
              <dd>{entry.exit_status ?? "Unavailable"}</dd>
            </dl>
            {entry.output != null ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
                {entry.output || "No output captured."}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">Retained output unavailable.</p>
            )}
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
