// Modified for Triune.
import { TooltipButton } from "@/components/ui/tooltip";
import { useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, TerminalIcon } from "lucide-react";
import { ActivityRow } from "@/components/ActivityRow";
import { PeerMessage } from "@/components/blocks/PeerMessage";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useChatActivity, type ChatActivityEntry } from "@/hooks/useChatActivity";
import { peerActivityKey, usePeerMessages } from "@/hooks/usePeerMessages";
import { AgentsViewModeControls, SubagentsPanel, type AgentsViewMode } from "./SubagentsPanel";

export interface ChatActivityTerminalTarget {
  sessionId: string;
  terminalId: string;
  workspaceId?: string;
}

export interface ChatActivityPanelProps {
  conversationId: string;
  rootSessionId: string;
  active?: boolean;
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

export function ChatActivityPanel(props: ChatActivityPanelProps) {
  // A chat switch must close retained output from the previous chat immediately.
  return <ChatActivityContent key={props.conversationId} {...props} />;
}

function ChatActivityContent({
  conversationId,
  rootSessionId,
  active = true,
  sourceControl,
  onOpenTerminal,
}: ChatActivityPanelProps) {
  const activity = useChatActivity(conversationId, { enabled: active });
  const peers = usePeerMessages(conversationId, { enabled: active });
  const [filter, setFilter] = useState<ActivityFilter>("All");
  const [viewMode, setViewMode] = useState<AgentsViewMode>("list");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const groups = shellGroups(activity.data?.data ?? []);
  const live = groups.filter((group) => ["running", "idle"].includes(groupState(group)));
  const past = groups.filter((group) => groupState(group) === "exited");
  const unavailable = groups.filter((group) =>
    ["unknown", "disconnected"].includes(groupState(group)),
  );
  const selected = groups.find((group) => group.id === selectedGroupId);

  const renderGroup = (group: ShellGroup) => (
    <ShellRow
      key={group.id}
      group={group}
      onOpenTerminal={onOpenTerminal}
      onInspect={() => setSelectedGroupId(group.id)}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--workspace-content)]">
      <div className="workspace-control-header flex items-center gap-1 border-b bg-[var(--workspace-content)] px-2">
        {sourceControl ?? <h2 className="pl-1 font-medium text-ui">Activity</h2>}
        <div
          role="group"
          aria-label="Activity filter"
          className="ml-auto flex items-center gap-0.5"
        >
          {(["All", "Agents", "Messages", "Shells"] as const).map((value) => (
            <Button
              key={value}
              variant={filter === value ? "secondary" : "ghost"}
              size="sm"
              className={filter === value ? "bg-[var(--workspace-selected)] px-2" : "px-2"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value}
            </Button>
          ))}
        </div>
        {(filter === "All" || filter === "Agents") && (
          <AgentsViewModeControls viewMode={viewMode} onViewModeChange={setViewMode} />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section aria-label="Agents" hidden={filter !== "All" && filter !== "Agents"}>
          <SubagentsPanel
            conversationId={conversationId}
            rootSessionId={rootSessionId}
            embedded
            viewMode={viewMode}
          />
        </section>
        <section
          aria-label="Messages"
          hidden={filter !== "All" && filter !== "Messages"}
          className="p-2"
        >
          <h3 className="px-2 text-sm font-medium">Messages</h3>
          {peers.isLoading && (
            <p className="px-2 text-sm text-muted-foreground">Loading outgoing messages…</p>
          )}
          {peers.error && (
            <div role="status" className="px-2 text-sm text-muted-foreground">
              <p>
                Outgoing messages could not be refreshed. Incoming messages reflect loaded
                conversation history.
              </p>
              <Button variant="ghost" size="sm" onClick={() => void peers.refetch()}>
                Retry messages
              </Button>
            </div>
          )}
          {peers.messages.length === 0 && !peers.isLoading && (
            <p className="px-2 text-sm text-muted-foreground">No messages in loaded history.</p>
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
        <section
          aria-label="Shell activity"
          hidden={filter !== "All" && filter !== "Shells"}
          className="space-y-2 p-2"
        >
          <h3 className="px-2 text-sm font-medium">Shells</h3>
          {activity.isLoading && (
            <p className="px-2 text-sm text-muted-foreground">Loading shell activity…</p>
          )}
          {activity.error && (
            <div role="status" className="px-2 text-sm text-muted-foreground">
              <p>
                {activity.data
                  ? "Shell activity could not be refreshed; showing the last recorded state."
                  : "Shell activity unavailable."}
              </p>
              <Button variant="ghost" size="sm" onClick={() => void activity.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {activity.data?.warning && (
            <p role="status" className="px-2 text-sm text-muted-foreground">
              {activity.data.warning}
            </p>
          )}
          {activity.data && activity.data.coverage !== "complete" && (
            <p className="px-2 text-xs text-muted-foreground">
              {typeof activity.data.coverage === "string"
                ? `History coverage: ${activity.data.coverage || "unavailable"}. Older shell activity may not have been recorded.`
                : `Up to ${activity.data.coverage.max_entries} retained entries; ${activity.data.coverage.max_output_bytes} bytes per output snapshot.`}
            </p>
          )}
          {typeof activity.data?.coverage === "object" &&
            activity.data.coverage.terminals === "unavailable" && (
              <p className="px-2 text-sm text-muted-foreground">
                Current terminal activity unavailable.
              </p>
            )}
          {activity.data && groups.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">
              No shell activity recorded for this chat.
            </p>
          )}
          {live.length > 0 && (
            <section aria-label="Live shells">
              <h4 className="px-2 py-1 text-xs text-muted-foreground">Live</h4>
              <ul>{live.map(renderGroup)}</ul>
            </section>
          )}
          {unavailable.length > 0 && (
            <section aria-label="Unavailable shells">
              <h4 className="px-2 py-1 text-xs text-muted-foreground">Unavailable</h4>
              <ul>{unavailable.map(renderGroup)}</ul>
            </section>
          )}
          {past.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="group w-full justify-start">
                  <ChevronRightIcon className="size-3.5 group-data-[state=open]:hidden" />
                  <ChevronDownIcon className="hidden size-3.5 group-data-[state=open]:block" />
                  Past ({past.length})
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul>{past.map(renderGroup)}</ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </section>
      </div>
      {selected && <ShellOutputDialog group={selected} onClose={() => setSelectedGroupId(null)} />}
    </div>
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
  const state = groupState(group);
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
    <li className="border-b border-border/50 px-2 last:border-b-0">
      <ActivityRow
        icon={<TerminalIcon aria-hidden="true" className="size-3.5" />}
        title={
          <TooltipButton
            type="button"
            className="min-w-0 truncate text-left text-sm hover:underline"
            onClick={openTerminal ?? onInspect}
          >
            {groupName(group)}
          </TooltipButton>
        }
        status={
          <>
            {STATE_LABELS[state]}
            {terminal?.exit_status != null ? ` · exit ${terminal.exit_status}` : ""}
          </>
        }
      >
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Inspect ${groupName(group)}`}
          onClick={onInspect}
        >
          Inspect output
        </Button>
        {terminal && (
          <p className="text-xs text-muted-foreground">
            Source conversation: {terminal.session_id}
          </p>
        )}
        {terminal?.owner_kind === "workspace" && (
          <p className="pl-6 text-xs text-muted-foreground">
            Workspace terminal · used by this chat
          </p>
        )}
        {terminal?.parent_agent_id && (
          <p className="truncate pl-6 text-xs text-muted-foreground">
            Agent: {terminal.parent_agent_id}
          </p>
        )}
        {live && !openTerminal && (
          <p className="pl-6 text-xs text-muted-foreground">Live terminal unavailable here.</p>
        )}
        {group.commands.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                Commands ({group.commands.length})
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="space-y-1 border-l pl-3">
                {group.commands.map((command) => (
                  <li key={command.id}>
                    <TooltipButton
                      type="button"
                      className="w-full truncate text-left font-mono text-xs hover:underline"
                      onClick={onInspect}
                    >
                      {command.name}
                    </TooltipButton>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </ActivityRow>
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
