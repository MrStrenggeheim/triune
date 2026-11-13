// Modified for Triune.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatActivity, type ChatActivityEntry } from "@/hooks/useChatActivity";
import { useChildSessionTree, type ChildSessionInfo } from "@/hooks/useChildSessions";
import { usePeerMessages } from "@/hooks/usePeerMessages";
import { useNativeChildCapabilities } from "@/hooks/useNativeChildCapabilities";
import { authenticatedFetch } from "@/lib/identity";
import { ChatActivityPanel, type ChatActivityPanelProps } from "./ChatActivityPanel";

vi.mock("@/hooks/useChatActivity", () => ({ useChatActivity: vi.fn() }));
vi.mock("@/hooks/useNativeChildCapabilities", () => ({ useNativeChildCapabilities: vi.fn() }));
vi.mock("@/hooks/useChildSessions", () => ({ useChildSessionTree: vi.fn() }));
vi.mock("@/hooks/usePeerMessages", () => ({
  usePeerMessages: vi.fn(),
  peerActivityKey: (message: { id: string }) => message.id,
}));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/components/blocks/PeerMessage", () => ({ PeerMessage: () => <div>Peer message</div> }));
vi.mock("./SubagentsGraphView", () => ({
  SubagentsGraphView: ({ rootSessionId }: { rootSessionId: string }) => (
    <div>Graph for {rootSessionId}</div>
  ),
}));

const query = vi.mocked(useChatActivity);
const refetch = vi.fn();
function entry(overrides: Partial<ChatActivityEntry> = {}): ChatActivityEntry {
  return {
    id: "shell",
    kind: "terminal",
    session_id: "origin-chat",
    terminal_id: "terminal_bash_a",
    name: "bash",
    state: "running",
    owner_kind: "chat",
    owner_id: "origin-chat",
    ...overrides,
  };
}
function child(overrides: Partial<ChildSessionInfo> = {}): ChildSessionInfo {
  return {
    id: "james",
    title: "reviewer:check",
    tool: "James",
    session_name: "check",
    task_summary: "Check navigation",
    current_task_status: "in_progress",
    busy: true,
    last_message_preview: null,
    pending_elicitations_count: 0,
    updated_at: 200,
    ...overrides,
  };
}
function agents(children: ChildSessionInfo[]) {
  vi.mocked(useChildSessionTree).mockReturnValue({ children, isLoading: false, error: null });
}
function activity(entries: ChatActivityEntry[], extra: Record<string, unknown> = {}) {
  query.mockReturnValue({
    data: { data: entries, coverage: "complete" },
    isLoading: false,
    error: null,
    refetch,
    ...extra,
  } as unknown as ReturnType<typeof useChatActivity>);
}
function panel(props: Partial<ChatActivityPanelProps> = {}) {
  return (
    <MemoryRouter>
      <ChatActivityPanel conversationId="selected-chat" rootSessionId="root-chat" {...props} />
    </MemoryRouter>
  );
}
function options() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Orchestration options" }), {
    button: 0,
    ctrlKey: false,
  });
  return within(screen.getByRole("menu"));
}
function choose(value: string) {
  fireEvent.click(options().getByRole("menuitemradio", { name: value }));
}
beforeEach(() => {
  vi.clearAllMocks();
  agents([]);
  vi.mocked(useNativeChildCapabilities).mockReturnValue({
    data: undefined,
    error: null,
  } as ReturnType<typeof useNativeChildCapabilities>);
  activity([]);

  vi.mocked(usePeerMessages).mockReturnValue({
    messages: [],
    isLoading: false,
    error: null,
    hasNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  } as unknown as ReturnType<typeof usePeerMessages>);
});
afterEach(cleanup);

it("shows settled history in separate sections ordered by observed activity", () => {
  agents([
    child({ id: "older", tool: "Older", updated_at: 100 }),
    child({
      id: "failed",
      tool: "Failed agent",
      busy: false,
      current_task_status: "failed",
      updated_at: 300,
    }),
    child({ busy: false, current_task_status: "completed" }),
  ]);
  activity([
    entry({ started_at: 100 }),
    entry({ id: "idle", name: "idle shell", state: "idle", started_at: 300 }),
    entry({ id: "past", name: "old shell", state: "exited", ended_at: 400 }),
    entry({ id: "lost", name: "lost shell", state: "disconnected" }),
  ]);
  const { container } = render(panel());
  const agentRows = within(screen.getByRole("list", { name: "Agents" })).getAllByRole("listitem");
  expect(agentRows.map((row) => row.querySelector("button")?.textContent)).toEqual([
    "Failed agentCheck navigation",
    "JamesCheck navigation",
    "OlderCheck navigation",
  ]);
  expect(agentRows[0]).toHaveTextContent("Failed");
  expect(agentRows[1]).toHaveTextContent("Completed");
  const shellRows = within(screen.getByRole("list", { name: "Shells" })).getAllByRole("listitem");
  expect(shellRows.map((row) => row.querySelector("button")?.textContent)).toEqual([
    "old shellold shell",
    "idle shellidle shell",
    "bashbash",
    "lost shelllost shell",
  ]);
  expect(shellRows[3]).toHaveTextContent("Disconnected · availability unknown");
  expect(container.querySelectorAll(".workspace-control-header")).toHaveLength(1);
  expect(container.querySelectorAll(".density-row")).toHaveLength(7);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("uses the shared header control for All, Agents and Shells", () => {
  agents([child()]);
  activity([entry()]);
  render(panel());
  const filter = screen.getByRole("group", { name: "Orchestration filter" });
  expect(filter).toHaveAttribute("data-slot", "segmented-control");
  expect(within(filter).getByRole("button", { name: "All" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(within(filter).getByRole("button", { name: "Shells" }));
  expect(screen.queryByRole("region", { name: "Agents" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Shells" })).toBeVisible();
  fireEvent.click(within(filter).getByRole("button", { name: "Agents" }));
  expect(screen.getByRole("region", { name: "Agents" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "Shells" })).not.toBeInTheDocument();
});

it("opens the same named child through its row and Open action without an inspector", () => {
  const agent = child({ busy: false, current_task_status: "completed" });
  agents([agent]);
  const open = vi.fn();
  render(panel({ onOpenAgent: open }));
  fireEvent.click(screen.getByRole("button", { name: "James" }));
  fireEvent.click(screen.getByRole("button", { name: "Open James" }));
  fireEvent.click(screen.getByRole("listitem").firstElementChild!);
  expect(open.mock.calls).toEqual([[agent], [agent], [agent]]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("highlights and consumes a link once across hide/restore while allowing a deliberate new request", () => {
  agents([child({ busy: false, current_task_status: "completed" })]);
  const consume = vi.fn();
  const open = vi.fn();
  const props = {
    focusAgentId: "james",
    linkRequestId: "first",
    onConsumeLinkIntent: consume,
    onOpenAgent: open,
  };
  const view = render(panel(props));
  expect(consume).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("listitem").firstElementChild).toHaveClass("ring-ring");
  view.rerender(panel({ ...props, active: false }));
  view.rerender(panel(props));
  expect(consume).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Shells" }));
  view.rerender(panel({ ...props, linkRequestId: "second" }));
  expect(consume).toHaveBeenCalledTimes(2);
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("reports an out-of-history target honestly without inventing an agent record", () => {
  const consume = vi.fn();
  render(panel({ focusAgentId: "missing", onConsumeLinkIntent: consume }));
  expect(consume).not.toHaveBeenCalled();
  expect(screen.getByText("Requested agent is outside the loaded history.")).toBeVisible();
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});

it("gates all queries by visibility and peer polling by the explicit Messages option", () => {
  const view = render(panel());
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  choose("Messages");
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: true });
  view.rerender(panel({ active: false }));
  expect(query).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  expect(useChildSessionTree).toHaveBeenLastCalledWith("root-chat", false);
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  view.rerender(panel());
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: true });
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
});

it.each(["running", "idle", "exited", "unknown", "disconnected"] as const)(
  "opens %s shell records through the tab callback with captured output and ownership",
  (state) => {
    const record = entry({
      state,
      output: "Saved output",
      owner_kind: "workspace",
      owner_id: "workspace",
      workspace_id: "workspace",
    });
    activity([record]);
    const open = vi.fn();
    render(panel({ onOpenTerminal: open }));
    fireEvent.click(screen.getByRole("button", { name: "Open bash" }));
    expect(open).toHaveBeenCalledWith({
      sessionId: "origin-chat",
      terminalId: "terminal_bash_a",
      workspaceId: "workspace",
      retainedOnly: state !== "running" && state !== "idle",
      activity: {
        id: JSON.stringify(["origin-chat", "shell"]),
        name: "bash",
        state,
        entries: [record],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "bash" }));
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);

it("retains command-only history and sends its output without a live attach target", () => {
  const command = entry({
    id: "bare",
    kind: "command",
    terminal_id: null,
    name: "pnpm test",
    state: "exited",
    output: "Tests passed",
  });
  activity([command]);
  const open = vi.fn();
  render(panel({ onOpenTerminal: open }));
  expect(screen.getByText("pnpm test")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open Commands without a terminal" }));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      terminalId: "",
      retainedOnly: true,
      activity: expect.objectContaining({ entries: [command] }),
    }),
  );
  expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
});

it("assigns commands by launch time and keeps reused terminal IDs isolated by session", () => {
  const old = entry({
    id: "old",
    name: "previous bash",
    state: "exited",
    started_at: 100,
    ended_at: 200,
  });
  const recent = entry({ id: "recent", started_at: 300 });
  const oldCommand = entry({
    id: "old-command",
    kind: "command",
    name: "old command",
    state: "exited",
    started_at: 150,
  });
  const newCommand = entry({
    id: "new-command",
    kind: "command",
    name: "new command",
    started_at: 350,
  });
  const other = entry({ id: "other", session_id: "another-chat", name: "other bash" });
  activity([old, recent, oldCommand, newCommand, other]);
  const open = vi.fn();
  render(panel({ onOpenTerminal: open }));
  expect(
    within(screen.getByRole("list", { name: "Shells" })).getAllByRole("listitem")[0],
  ).toHaveTextContent("new command");
  fireEvent.click(screen.getByRole("button", { name: "Open previous bash" }));
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({ activity: expect.objectContaining({ entries: [old, oldCommand] }) }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open bash" }));
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      activity: expect.objectContaining({ entries: [recent, newCommand] }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open other bash" }));
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionId: "another-chat",
      activity: expect.objectContaining({ entries: [other] }),
    }),
  );
});

it("uses exact advisories and exposes bounded coverage inline", () => {
  activity([], {
    data: {
      data: [],
      warning: "Exit timestamps are unavailable.",
      coverage: {
        terminals: "available",
        history: "partial",
        output: "bounded",
        non_tty_commands: "recorded",
        native_vendor_shells: "unavailable",
        max_entries: 128,
        max_output_bytes: 8192,
      },
    },
  });
  render(panel());
  expect(screen.getByText("Exit timestamps are unavailable.")).toBeVisible();
  expect(screen.queryByText("History incomplete")).not.toBeInTheDocument();
  fireEvent.click(options().getByRole("menuitem", { name: "History coverage" }));
  expect(screen.getByRole("region", { name: "History coverage" })).toHaveTextContent(
    "128 retained shell entries; 8192 bytes",
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps graph navigation as an explicit option", async () => {
  render(panel());
  choose("Graph view");
  expect(await screen.findByText("Graph for root-chat")).toBeVisible();
  choose("List view");
  expect(screen.getByRole("list", { name: "Agents" })).toBeVisible();
});

it("stops only capability-approved running agents and keeps failures visible", async () => {
  const running = child();
  agents([
    running,
    child({ id: "done", tool: "Done agent", busy: false, current_task_status: "completed" }),
  ]);
  const open = vi.fn();
  const stop = vi.fn().mockRejectedValue(new Error("Native stop unavailable"));
  const view = render(panel({ onOpenAgent: open, onStopAgent: stop }));
  expect(screen.queryByRole("button", { name: "Stop James" })).not.toBeInTheDocument();
  view.rerender(panel({ onOpenAgent: open, onStopAgent: stop, canStopAgent: () => true }));
  expect(screen.queryByRole("button", { name: "Stop Done agent" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop James" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Native stop unavailable");
  expect(stop).toHaveBeenCalledWith(running);
  expect(open).not.toHaveBeenCalled();
});

it("stops the captured shell owner and refetches without opening a tab", async () => {
  activity([entry({ owner_kind: "workspace", owner_id: "workspace" })]);
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(null, { status: 204 }));
  const open = vi.fn();
  render(panel({ onOpenTerminal: open }));
  fireEvent.click(screen.getByRole("button", { name: "Stop bash" }));
  await waitFor(() => expect(refetch).toHaveBeenCalled());
  expect(authenticatedFetch).toHaveBeenCalledWith(
    "/v1/workbench-workspaces/workspace/terminals/terminal_bash_a",
    { method: "DELETE" },
  );
  expect(open).not.toHaveBeenCalled();
});

it("queries controls only for running native children and requires an affirmative current capability", async () => {
  const native = child({ labels: { "omnigent.wrapper": "codex-native-ui-subagent" } });
  const settled = child({
    id: "settled",
    tool: "Settled",
    labels: { "omnigent.wrapper": "claude-code-native-ui-subagent" },
    busy: false,
    current_task_status: "completed",
  });
  const managed = child({ id: "managed", tool: "Managed" });
  agents([native, settled, managed]);
  const stop = vi.fn().mockResolvedValue(undefined);
  const props = { onStopAgent: stop, canStopAgent: () => true };
  const view = render(panel(props));
  expect(useNativeChildCapabilities).toHaveBeenLastCalledWith("james", true);
  expect(vi.mocked(useNativeChildCapabilities).mock.calls.every(([id]) => id === "james")).toBe(
    true,
  );
  expect(screen.queryByRole("button", { name: "Stop James" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Stop Managed" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Stop Settled" })).not.toBeInTheDocument();
  vi.mocked(useNativeChildCapabilities).mockReturnValue({
    data: { version: 1, state: "running", can_reply: false, can_steer: false, can_stop: true },
    error: null,
  } as ReturnType<typeof useNativeChildCapabilities>);
  view.rerender(panel(props));
  fireEvent.click(screen.getByRole("button", { name: "Stop James" }));
  await waitFor(() => expect(stop).toHaveBeenCalledWith(native));
  view.rerender(panel({ ...props, active: false }));
  expect(useNativeChildCapabilities).toHaveBeenLastCalledWith("james", false);
  expect(screen.queryByRole("button", { name: "Stop James" })).not.toBeInTheDocument();
  vi.mocked(useNativeChildCapabilities).mockReturnValue({
    data: { can_stop: true },
    error: new Error("Capability refresh failed"),
  } as ReturnType<typeof useNativeChildCapabilities>);
  view.rerender(panel(props));
  expect(screen.queryByRole("button", { name: "Stop James" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open James" })).toBeVisible();
});
