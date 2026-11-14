// Modified for Triune.
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  BotIcon,
  EllipsisIcon,
  MessageCircleIcon,
  SquareArrowOutUpRightIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { BackgroundTaskInfo } from "@/lib/types";
import { ActivityRow } from "@/components/ActivityRow";
import { SubagentTaskStatus } from "@/components/blocks/SubagentTaskRow";
import { FilePathAwareMessageResponse } from "@/components/blocks/ChatMarkdown";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { useChatActivity, type ChatActivityEntry } from "@/hooks/useChatActivity";
import { useChildSessionTree, type ChildSessionInfo } from "@/hooks/useChildSessions";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSessionShellResources,
  shellResourceKey,
  shellResourcePath,
  shellStopRequest,
  sessionShellResourcesKey,
  sessionShellResourceKey,
  shellResourceMatchesActivity,
} from "@/hooks/useSessionShellResources";
import { useNativeChildCapabilities } from "@/hooks/useNativeChildCapabilities";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { subagentName, subagentTaskDescription } from "@/lib/subagentActivity";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";
import { childStatus, type AgentActivity } from "./subagentStatus";
import { panelFolderKey, useResourceViewState } from "@/lib/panelFolder";
import { useScrollRestore } from "./useScrollRestore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SubagentsGraphView = lazy(() =>
  import("./SubagentsGraphView").then((module) => ({ default: module.SubagentsGraphView })),
);
const NO_SHELL_RESOURCES: BackgroundTaskInfo[] = [];

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
  shellResource?: BackgroundTaskInfo;
}

export interface ChatActivityPanelProps {
  viewId?: string;
  conversationId: string;
  rootSessionId: string;
  active?: boolean;
  focusAgentId?: string;
  /** Stable activity entry ID, never a command-text or process-ID match. */
  focusShellId?: string;
  linkRequestId?: string;
  sourceControl?: ReactNode;
  /** Server-projected native shell inventory, including settled records. */
  shellResources?: BackgroundTaskInfo[];
  onOpenAgent?: (child: ChildSessionInfo) => void;
  onConsumeLinkIntent?: () => void;
  canStopAgent?: (child: ChildSessionInfo) => boolean;
  onStopAgent?: (child: ChildSessionInfo) => Promise<void>;
  /** Open this exact existing resource, even when it belongs to another chat. */
  onOpenTerminal?: (target: ChatActivityTerminalTarget) => void;
  canStopShell?: (target: ChatActivityTerminalTarget) => boolean;
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
  idle: "Shell open",
  exited: "Exited",
  disconnected: "Disconnected",
  unknown: "Unknown",
};

const STATE_ACTIVITY: Record<ChatActivityEntry["state"], AgentActivity> = {
  running: "working",
  idle: "idle",
  exited: "done",
  disconnected: "disconnected",
  unknown: "other",
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
  viewId,
  conversationId,
  rootSessionId,
  active = true,
  focusAgentId,
  focusShellId,
  linkRequestId,
  sourceControl,
  shellResources: shellResourcesOverride,
  onOpenAgent,
  onConsumeLinkIntent,
  canStopAgent,
  onStopAgent,
  onOpenTerminal,
}: ChatActivityPanelProps) {
  const [filter, setFilter] = useResourceViewState<ActivityFilter>(
    conversationId,
    viewId,
    "activity-filter",
    "All",
  );
  const [viewMode, setViewMode] = useResourceViewState<string>(
    conversationId,
    viewId,
    "activity-mode",
    "list",
  );
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [highlightedAgent, setHighlightedAgent] = useState<string>();
  const [highlightedShell, setHighlightedShell] = useState<string>();
  const consumedIntent = useRef<string | null>(null);
  const handledIntent = useRef<string | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const workbench = useWorkbenchActions();
  const agents = useChildSessionTree(rootSessionId, active);
  const activity = useChatActivity(conversationId, { enabled: active });
  const shells = useSessionShellResources(conversationId, {
    enabled:
      active && filter !== "Agents" && viewMode === "list" && shellResourcesOverride === undefined,
  });
  const shellResources = shellResourcesOverride ?? shells.data?.data ?? NO_SHELL_RESOURCES;
  const handleScroll = useScrollRestore(
    rowsRef,
    viewId ? `activity:${panelFolderKey(conversationId, viewId)}:${filter}:${viewMode}` : null,
    !agents.isLoading && activity.data !== undefined,
    true,
    active,
  );
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
    if (!active || (!focusAgentId && !focusShellId)) return;
    const intent = JSON.stringify([focusAgentId, focusShellId, linkRequestId]);
    if (consumedIntent.current === intent) return;
    consumedIntent.current = intent;
    setHighlightedAgent(focusAgentId);
    setHighlightedShell(focusShellId);
    setFilter(focusShellId ? "Shells" : "Agents");
    setViewMode("list");
  }, [active, focusAgentId, focusShellId, linkRequestId, setFilter, setViewMode]);
  useEffect(() => {
    if (!active || (!highlightedAgent && !highlightedShell)) return;
    const row = [
      ...(rowsRef.current?.querySelectorAll<HTMLElement>("[data-agent-id], [data-shell-id]") ?? []),
    ].find((element) =>
      highlightedShell
        ? element.dataset.shellId === highlightedShell
        : element.dataset.agentId === highlightedAgent,
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
    highlightedShell,
    focusShellId,
    activity.data,
    shellResources,
    filter,
    viewMode,
    agents.children,
    onConsumeLinkIntent,
  ]);

  const resourceShells = shellResources.map((task) => {
    const group =
      task.source === "registered_terminal"
        ? groups.find(
            (candidate) =>
              candidate.terminal?.id === task.resource_id &&
              candidate.terminal?.session_id === conversationId,
          )
        : undefined;
    const latest = group
      ? [...group.commands].sort(
          (left, right) => (timestamp(right.started_at) ?? 0) - (timestamp(left.started_at) ?? 0),
        )[0]
      : undefined;
    return latest && !task.command ? { ...task, command: latest.name } : task;
  });
  const legacyGroups = groups.flatMap((group) => {
    if (
      group.terminal &&
      shellResources.some((task) =>
        shellResourceMatchesActivity(task, group.terminal!, conversationId),
      )
    )
      return [];
    const commands = group.commands.filter(
      (entry) =>
        !shellResources.some((task) => shellResourceMatchesActivity(task, entry, conversationId)),
    );
    return group.terminal || commands.length ? [{ ...group, commands }] : [];
  });

  function openAgent(child: ChildSessionInfo) {
    if (onOpenAgent) onOpenAgent(child);
    else if (workbench)
      workbench.openView(
        { kind: "conversation", conversationId: child.id, title: subagentName(child) },
        { beside: true },
      );
    else window.location.assign(`/c/${encodeURIComponent(child.id)}`);
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
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div ref={rowsRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
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
        {shells.error && shellResourcesOverride === undefined && (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            Could not refresh shell controls: {shells.error.message}
          </p>
        )}
        {viewMode === "list" && (
          <>
            {filter !== "Shells" && (
              <section aria-label="Agents" className="p-2">
                <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">Agents</h3>
                <ul aria-label="Agents" className="density-list flex flex-col">
                  {children.map((child) => (
                    <li key={child.id} data-agent-id={child.id}>
                      <AgentResourceRow
                        child={child}
                        conversationId={conversationId}
                        active={active}
                        selected={highlightedAgent === child.id}
                        onOpen={() => openAgent(child)}
                        canStopAgent={canStopAgent}
                        onStopAgent={onStopAgent}
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
                  {resourceShells.map((task) => (
                    <li key={shellFocusId(task) ?? task.id} data-shell-id={shellFocusId(task)}>
                      <ShellResourceRow
                        task={task}
                        conversationId={conversationId}
                        selected={highlightedShell === shellFocusId(task)}
                        allowStop={active && !shells.error}
                        onOpenTerminal={onOpenTerminal}
                      />
                    </li>
                  ))}
                  {legacyGroups.map((group) => (
                    <ShellRow
                      key={group.id}
                      group={group}
                      conversationId={conversationId}
                      selected={highlightedShell === (group.terminal?.id ?? group.commands[0]?.id)}
                      onOpenTerminal={onOpenTerminal}
                    />
                  ))}
                </ul>
                {!legacyGroups.length && !resourceShells.length && (
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
      </div>
    </div>
  );
}

export function shellFocusId(task: BackgroundTaskInfo): string | undefined {
  return shellResourceKey(task);
}

export function ShellResourceRow({
  task,
  conversationId,
  selected = false,
  allowStop = false,
  onOpenTerminal,
}: {
  task: BackgroundTaskInfo;
  conversationId: string;
  selected?: boolean;
  allowStop?: boolean;
  onOpenTerminal?: ChatActivityPanelProps["onOpenTerminal"];
}) {
  const queryClient = useQueryClient();
  const workbench = useWorkbenchActions();
  const orchestration = useResourceOrchestration(conversationId);
  const name = task.command?.trim() || task.description?.trim() || "Background task";
  const focusId = shellFocusId(task);
  const live = ["running", "idle", "in_progress"].includes(task.status ?? "running");
  const failed = task.status === "failed" || (task.exit_code != null && task.exit_code !== 0);
  const ended = ["completed", "exited", "stopped", "killed", "declined", "failed"].includes(
    task.status ?? "",
  );
  const resourcePath = shellResourcePath(conversationId, task);
  const open =
    (workbench || onOpenTerminal) &&
    conversationId &&
    task.can_open === true &&
    resourcePath &&
    task.resource_url === resourcePath &&
    focusId
      ? () => {
          const request = {
            kind: "terminal" as const,
            conversationId,
            terminalId: focusId,
            terminalOwner: "conversation" as const,
            title: name,
            shellResource: task,
          };
          if (onOpenTerminal)
            onOpenTerminal({
              sessionId: conversationId,
              terminalId: focusId,
              shellResource: task,
              retainedOnly: true,
            });
          else workbench!.openView(request, { beside: true });
        }
      : undefined;
  const stopRequest = allowStop ? shellStopRequest(conversationId, task) : undefined;
  const stop = stopRequest
    ? async () => {
        const response = await authenticatedFetch(stopRequest.url, { method: stopRequest.method });
        if (!response.ok) throw await apiErrorFromResponse(response);
        await queryClient.invalidateQueries({
          queryKey: sessionShellResourcesKey(conversationId),
          exact: true,
        });
        await queryClient.invalidateQueries({
          queryKey: sessionShellResourceKey(conversationId, task),
          exact: true,
        });
      }
    : undefined;
  return (
    <ActivityRow
      icon={<SquareTerminalIcon aria-hidden="true" />}
      title={name}
      description={task.output_preview ?? ""}
      selected={selected}
      onOpen={open}
      onStop={stop}
      status={
        <SubagentTaskStatus
          status={{
            activity: failed ? "failed" : ended ? "done" : live ? "working" : "other",
            label: failed
              ? "Failed"
              : ended
                ? "Completed"
                : live
                  ? "Running"
                  : (task.status ?? "Unknown"),
          }}
          label={
            failed
              ? "Failed"
              : ended
                ? task.status === "stopped" || task.status === "killed"
                  ? "Stopped"
                  : "Completed"
                : live
                  ? "Running"
                  : (task.status ?? "Unknown")
          }
        />
      }
      actions={
        <ActivityNavigation
          name={name}
          shell
          onOpen={open}
          onOrchestration={
            orchestration && focusId ? () => orchestration({ focusShellId: focusId }) : undefined
          }
        />
      }
    />
  );
}

export function ActivityNavigation({
  name,
  shell = false,
  onOpen,
  onOrchestration,
}: {
  name: string;
  shell?: boolean;
  onOpen?: () => void;
  onOrchestration?: () => void;
}) {
  return (
    <>
      {onOpen && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Open ${shell ? "shell" : "chat"} beside · ${name}`}
          onClick={onOpen}
        >
          {shell ? (
            <SquareTerminalIcon aria-hidden="true" className="size-4" />
          ) : (
            <MessageCircleIcon aria-hidden="true" className="size-4" />
          )}
        </Button>
      )}
      {onOrchestration && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Show ${name} in Orchestration`}
          onClick={onOrchestration}
        >
          <SquareArrowOutUpRightIcon aria-hidden="true" className="size-4" />
        </Button>
      )}
    </>
  );
}

export function useResourceOrchestration(conversationId: string) {
  const workbench = useWorkbenchActions();
  return workbench && conversationId
    ? (focus: { focusAgentId?: string; focusShellId?: string }) => {
        const request = {
          kind: "activity" as const,
          conversationId,
          source: { kind: "chat" as const, conversationId },
          ...focus,
          linkRequestId: crypto.randomUUID(),
          title: "Orchestration",
        };
        workbench.openView(request, { beside: true });
      }
    : undefined;
}

type AgentResourceRowProps = Pick<ChatActivityPanelProps, "canStopAgent" | "onStopAgent"> & {
  child: ChildSessionInfo;
  conversationId: string;
  active?: boolean;
  selected?: boolean;
  onOpen: () => void;
  href?: string;
};

/** Shared agent identity, task summary, status and actions in every resource list. */
export function AgentResourceRow(props: AgentResourceRowProps) {
  const native = props.child.labels?.["omnigent.wrapper"]?.endsWith("-native-ui-subagent");
  if (native && ["launching", "working", "awaiting"].includes(childStatus(props.child).activity))
    return <NativeAgentResourceRow {...props} />;
  return <AgentResourceContent {...props} canStop={props.canStopAgent?.(props.child) === true} />;
}

function NativeAgentResourceRow(props: AgentResourceRowProps) {
  const capabilities = useNativeChildCapabilities(props.child.id, props.active !== false);
  return (
    <AgentResourceContent
      {...props}
      canStop={!capabilities.error && capabilities.data?.can_stop === true}
    />
  );
}

function AgentResourceContent({
  child,
  conversationId,
  onOpen,
  active = true,
  selected,
  onStopAgent,
  canStop,
  href,
}: AgentResourceRowProps & { canStop: boolean }) {
  const orchestration = useResourceOrchestration(conversationId);
  const name = subagentName(child);
  const running = ["launching", "working", "awaiting"].includes(childStatus(child).activity);
  return (
    <ActivityRow
      icon={<BotIcon aria-hidden="true" />}
      title={name}
      selected={selected}
      href={href}
      onOpen={onOpen}
      descriptionText={subagentTaskDescription(child) ?? child.last_message_preview ?? ""}
      description={
        <ConversationScopeContext.Provider value={child.id}>
          <FilePathAwareMessageResponse
            mode="static"
            className="text-xs leading-4 [&>*]:my-0 [&_p]:my-0"
          >
            {subagentTaskDescription(child) ?? child.last_message_preview ?? ""}
          </FilePathAwareMessageResponse>
        </ConversationScopeContext.Provider>
      }
      status={<SubagentTaskStatus status={childStatus(child)} />}
      onStop={active && running && canStop && onStopAgent ? () => onStopAgent(child) : undefined}
      actions={
        <ActivityNavigation
          name={name}
          onOpen={onOpen}
          onOrchestration={
            orchestration ? () => orchestration({ focusAgentId: child.id }) : undefined
          }
        />
      }
    />
  );
}

function ShellRow({
  group,
  conversationId,
  selected,
  onOpenTerminal,
}: {
  group: ShellGroup;
  conversationId: string;
  selected?: boolean;
  onOpenTerminal?: ChatActivityPanelProps["onOpenTerminal"];
}) {
  const orchestration = useResourceOrchestration(conversationId);
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
    retainedOnly: true,
    activity: { id: group.id, name: groupName(group), state, entries },
  };
  const open = () => onOpenTerminal?.(target);
  return (
    <li data-shell-id={owner.id}>
      <ActivityRow
        selected={selected}
        icon={<SquareTerminalIcon aria-hidden="true" className="size-3.5" />}
        title={latest?.name ?? groupName(group)}
        description={
          (latest?.output ?? terminal?.output ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) ??
          ""
        }
        onOpen={onOpenTerminal ? open : undefined}
        actions={
          <ActivityNavigation
            name={groupName(group)}
            shell
            onOpen={onOpenTerminal ? open : undefined}
            onOrchestration={
              orchestration ? () => orchestration({ focusShellId: owner.id }) : undefined
            }
          />
        }
        status={
          <SubagentTaskStatus
            status={{
              activity: state === "exited" && owner.exit_status ? "failed" : STATE_ACTIVITY[state],
              label: STATE_LABELS[state],
            }}
            label={STATE_LABELS[state]}
          />
        }
      />
    </li>
  );
}
