// Modified for Triune.
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { BotIcon, EllipsisIcon, TerminalIcon } from "lucide-react";
import { ActivityRow } from "@/components/ActivityRow";
import { SubagentTaskStatus } from "@/components/blocks/SubagentTaskRow";
import { PeerMessage } from "@/components/blocks/PeerMessage";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { useChatActivity, type ChatActivityEntry } from "@/hooks/useChatActivity";
import { useChildSessionTree, type ChildSessionInfo } from "@/hooks/useChildSessions";
import { peerActivityKey, usePeerMessages } from "@/hooks/usePeerMessages";
import { useNativeChildCapabilities } from "@/hooks/useNativeChildCapabilities";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { subagentName, subagentTaskDescription } from "@/lib/subagentActivity";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";
import { childStatus } from "./subagentStatus";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SubagentsGraphView = lazy(() =>
  import("./SubagentsGraphView").then((module) => ({ default: module.SubagentsGraphView })),
);

export interface ChatActivityShellSnapshot {
  id: string;
  name: string;
  state: ChatActivityEntry["state"];
  entries: ChatActivityEntry[];
}

export interface ChatActivityTerminalTarget {
  sessionId: string;
  terminalId: string;
  workspaceId?: string;
  /** Settled records must open retained output without attaching or creating a process. */
  retainedOnly?: boolean;
  activity?: ChatActivityShellSnapshot;
}

export interface ChatActivityPanelProps {
  conversationId: string;
  rootSessionId: string;
  active?: boolean;
  focusAgentId?: string;
  linkRequestId?: string;
  sourceControl?: ReactNode;
  onOpenAgent?: (child: ChildSessionInfo) => void;
  onConsumeLinkIntent?: () => void;
  canStopAgent?: (child: ChildSessionInfo) => boolean;
  onStopAgent?: (child: ChildSessionInfo) => Promise<void>;
  /** Open this exact existing resource, even when it belongs to another chat. */
  onOpenTerminal?: (target: ChatActivityTerminalTarget) => void;
}

export type ActivityFilter = "All" | "Agents" | "Shells";

export function ActivityFilterControl({
  value,
  onChange,
}: {
  value: ActivityFilter;
  onChange: (value: ActivityFilter) => void;
}) {
  return (
    <SegmentedControl aria-label="Orchestration filter" className="ml-auto">
      {(["All", "Agents", "Shells"] as const).map((filter) => (
        <SegmentedControlItem
          key={filter}
          label={filter}
          active={filter === value}
          onClick={() => onChange(filter)}
        >
          {filter}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

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
            terminal.session_id === entry.session_id &&
            terminal.terminal_id === entry.terminal_id &&
            terminal.owner_kind === entry.owner_kind &&
            terminal.owner_id === entry.owner_id,
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
        : JSON.stringify(["commands", entry.session_id, entry.owner_kind, entry.owner_id]);
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
    (group.commands.every((entry) => !entry.terminal_id)
      ? "Commands without a terminal"
      : "Recorded shell commands")
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
  onOpenAgent,
  onConsumeLinkIntent,
  canStopAgent,
  onStopAgent,
  onOpenTerminal,
}: ChatActivityPanelProps) {
  const [filter, setFilter] = useState<ActivityFilter>("All");
  const [viewMode, setViewMode] = useState("list");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [highlightedAgent, setHighlightedAgent] = useState<string>();
  const consumedIntent = useRef<string | null>(null);
  const handledIntent = useRef<string | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const workbench = useWorkbenchActions();
  const agents = useChildSessionTree(rootSessionId, active);
  const activity = useChatActivity(conversationId, { enabled: active });
  const peers = usePeerMessages(conversationId, { enabled: active && viewMode === "messages" });
  const groups = shellGroups(activity.data?.data ?? []).sort(
    (left, right) =>
      groupLastActive(right) - groupLastActive(left) || left.id.localeCompare(right.id),
  );
  const children = [...agents.children].sort(
    (left, right) =>
      (right.updated_at ?? right.created_at ?? 0) - (left.updated_at ?? left.created_at ?? 0) ||
      left.id.localeCompare(right.id),
  );
  useEffect(() => {
    if (!active || !focusAgentId) return;
    const intent = JSON.stringify([focusAgentId, linkRequestId]);
    if (consumedIntent.current === intent) return;
    consumedIntent.current = intent;
    setHighlightedAgent(focusAgentId);
    setFilter("Agents");
    setViewMode("list");
  }, [active, focusAgentId, linkRequestId]);
  useEffect(() => {
    if (!active || !highlightedAgent || highlightedAgent !== focusAgentId) return;
    const row = [...(rowsRef.current?.querySelectorAll<HTMLElement>("[data-agent-id]") ?? [])].find(
      (element) => element.dataset.agentId === highlightedAgent,
    );
    row?.scrollIntoView?.({ block: "nearest" });
    if (row && handledIntent.current !== consumedIntent.current) {
      handledIntent.current = consumedIntent.current;
      onConsumeLinkIntent?.();
    }
  }, [
    active,
    focusAgentId,
    linkRequestId,
    highlightedAgent,
    filter,
    viewMode,
    agents.children,
    onConsumeLinkIntent,
  ]);

  function openAgent(child: ChildSessionInfo) {
    if (onOpenAgent) onOpenAgent(child);
    else if (workbench)
      workbench.openView(
        { kind: "conversation", conversationId: child.id, title: subagentName(child) },
        { beside: true },
      );
    else window.location.assign(`/c/${encodeURIComponent(child.id)}`);
  }

  async function stopShell(target: ChatActivityTerminalTarget) {
    const path = target.workspaceId
      ? `/v1/workbench-workspaces/${encodeURIComponent(target.workspaceId)}/terminals/${encodeURIComponent(target.terminalId)}`
      : `/v1/sessions/${encodeURIComponent(target.sessionId)}/resources/terminals/${encodeURIComponent(target.terminalId)}`;
    try {
      const response = await authenticatedFetch(path, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw await apiErrorFromResponse(response);
    } finally {
      void activity.refetch();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--workspace-content)]">
      <header className="workspace-control-header flex min-w-0 shrink-0 items-center gap-1 border-b bg-[var(--workspace-content)] px-2">
        {sourceControl ?? (
          <h2 className="min-w-0 truncate pl-1 font-medium text-ui">Orchestration</h2>
        )}
        <ActivityFilterControl
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setViewMode("list");
          }}
        />
        <DropdownMenu open={active && optionsOpen} onOpenChange={setOptionsOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Orchestration options">
              <EllipsisIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={viewMode} onValueChange={setViewMode}>
              <DropdownMenuRadioItem value="list">List view</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="graph">Graph view</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="messages">Messages</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDetailsOpen((value) => !value)}>
              History coverage
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div ref={rowsRef} className="min-h-0 flex-1 overflow-y-auto">
        {agents.error && (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            Could not refresh agents: {agents.error.message}
          </p>
        )}
        {activity.error && (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            Could not refresh shells: {activity.error.message}
          </p>
        )}
        {activity.data?.warning && (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            {activity.data.warning}
          </p>
        )}
        {detailsOpen && (
          <section
            aria-label="History coverage"
            className="px-3 py-2 text-xs text-muted-foreground"
          >
            <p>
              Agents include up to three descendant levels. Older or deeper work may be outside the
              loaded records.
            </p>
            {typeof activity.data?.coverage === "object" ? (
              <>
                <p>
                  Up to {activity.data.coverage.max_entries} retained shell entries;{" "}
                  {activity.data.coverage.max_output_bytes} bytes per output snapshot.
                </p>
                <p>
                  Shell capture: {activity.data.coverage.terminals}; history:{" "}
                  {activity.data.coverage.history}; output: {activity.data.coverage.output}.
                </p>
                <p>
                  Commands without a terminal: {activity.data.coverage.non_tty_commands}; native
                  shells: {activity.data.coverage.native_vendor_shells}.
                </p>
              </>
            ) : (
              activity.data && (
                <p>Shell history coverage: {activity.data.coverage || "unavailable"}.</p>
              )
            )}
          </section>
        )}
        {viewMode === "list" && (
          <>
            {filter !== "Shells" && (
              <section aria-label="Agents" className="p-2">
                <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">Agents</h3>
                <ul aria-label="Agents" className="density-list flex flex-col">
                  {children.map((child) => (
                    <li key={child.id} data-agent-id={child.id}>
                      <ActivityRow
                        icon={<BotIcon aria-hidden="true" className="size-3.5" />}
                        title={subagentName(child)}
                        description={
                          subagentTaskDescription(child) ??
                          child.last_message_preview ??
                          "No task description recorded"
                        }
                        selected={highlightedAgent === child.id}
                        onOpen={() => openAgent(child)}
                        status={
                          <>
                            <SubagentTaskStatus status={childStatus(child)} />
                            <AgentActions
                              child={child}
                              active={active}
                              onOpen={() => openAgent(child)}
                              onStopAgent={onStopAgent}
                              canStopAgent={canStopAgent}
                            />
                          </>
                        }
                      />
                    </li>
                  ))}
                </ul>
                {!children.length && (
                  <p role="status" className="p-2 text-sm text-muted-foreground">
                    {agents.isLoading ? "Loading agents…" : "No agents in loaded history."}
                  </p>
                )}
                {highlightedAgent &&
                  !children.some((child) => child.id === highlightedAgent) &&
                  !agents.isLoading && (
                    <p role="status" className="p-2 text-sm text-muted-foreground">
                      Requested agent is outside the loaded history.
                    </p>
                  )}
              </section>
            )}
            {filter !== "Agents" && (
              <section aria-label="Shells" className="p-2">
                <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">Shells</h3>
                <ul aria-label="Shells" className="density-list flex flex-col">
                  {groups.map((group) => (
                    <ShellRow
                      key={group.id}
                      group={group}
                      onOpenTerminal={onOpenTerminal}
                      onStop={stopShell}
                    />
                  ))}
                </ul>
                {!groups.length && (
                  <p role="status" className="p-2 text-sm text-muted-foreground">
                    {activity.isLoading ? "Loading shells…" : "No shells in loaded history."}
                  </p>
                )}
              </section>
            )}
          </>
        )}
        {viewMode === "graph" && active && (
          <Suspense
            fallback={
              <p role="status" className="p-3 text-sm">
                Loading graph…
              </p>
            }
          >
            <SubagentsGraphView conversationId={conversationId} rootSessionId={rootSessionId} />
          </Suspense>
        )}
        {viewMode === "messages" && (
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
            {!peers.messages.length && !peers.isLoading && (
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
    </div>
  );
}

type AgentActionsProps = Pick<ChatActivityPanelProps, "onStopAgent" | "canStopAgent"> & {
  child: ChildSessionInfo;
  active: boolean;
  onOpen: () => void;
};

function AgentActions(props: AgentActionsProps) {
  const running = props.child.busy || props.child.current_task_status === "launching";
  const native = props.child.labels?.["omnigent.wrapper"]?.endsWith("-native-ui-subagent");
  if (native && running) return <NativeAgentActions {...props} />;
  return (
    <ActivityActions
      name={subagentName(props.child)}
      onOpen={props.onOpen}
      onStop={
        running && props.active && props.onStopAgent && props.canStopAgent?.(props.child)
          ? () => props.onStopAgent!(props.child)
          : undefined
      }
    />
  );
}

function NativeAgentActions({ child, active, onOpen, onStopAgent }: AgentActionsProps) {
  const capabilities = useNativeChildCapabilities(child.id, active);
  return (
    <ActivityActions
      name={subagentName(child)}
      onOpen={onOpen}
      onStop={
        active && !capabilities.error && capabilities.data?.can_stop === true && onStopAgent
          ? () => onStopAgent(child)
          : undefined
      }
    />
  );
}

export function ActivityActions({
  name,
  onOpen,
  onStop,
}: {
  name: string;
  onOpen: () => void;
  onStop?: () => Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <span className="flex items-center gap-1">
      {error && (
        <span role="alert" className="max-w-48 text-destructive">
          {error}
        </span>
      )}
      {onStop && (
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Stop ${name}`}
          disabled={stopping}
          onClick={async () => {
            setStopping(true);
            setError(undefined);
            try {
              await onStop();
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure));
            } finally {
              setStopping(false);
            }
          }}
        >
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      )}
      <Button variant="ghost" size="xs" aria-label={`Open ${name}`} onClick={onOpen}>
        Open
      </Button>
    </span>
  );
}

function ShellRow({
  group,
  onOpenTerminal,
  onStop,
}: {
  group: ShellGroup;
  onOpenTerminal?: ChatActivityPanelProps["onOpenTerminal"];
  onStop: (target: ChatActivityTerminalTarget) => Promise<void>;
}) {
  const terminal = group.terminal;
  const entries = [...(terminal ? [terminal] : []), ...group.commands];
  const latest = [...group.commands].sort(
    (a, b) => (timestamp(b.started_at) ?? 0) - (timestamp(a.started_at) ?? 0),
  )[0];
  const owner = terminal ?? latest;
  const state = groupState(group);
  const target: ChatActivityTerminalTarget = {
    sessionId: owner.session_id,
    terminalId: owner.terminal_id ?? "",
    ...(owner.owner_kind === "workspace"
      ? { workspaceId: owner.workspace_id ?? owner.owner_id }
      : {}),
    retainedOnly: !terminal || !isLive(terminal),
    activity: { id: group.id, name: groupName(group), state, entries },
  };
  const open = () => onOpenTerminal?.(target);
  return (
    <li>
      <ActivityRow
        icon={<TerminalIcon aria-hidden="true" className="size-3.5" />}
        title={groupName(group)}
        description={latest?.name ?? terminal?.name ?? "No command recorded"}
        onOpen={open}
        status={
          <>
            <span
              className={
                state === "running" || state === "idle"
                  ? "text-session-active"
                  : state === "exited" && owner.exit_status
                    ? "text-destructive"
                    : "text-muted-foreground"
              }
            >
              {STATE_LABELS[state]}
            </span>
            <ActivityActions
              name={groupName(group)}
              onOpen={open}
              onStop={
                terminal && isLive(terminal) && terminal.terminal_id
                  ? () => onStop(target)
                  : undefined
              }
            />
          </>
        }
      />
    </li>
  );
}
