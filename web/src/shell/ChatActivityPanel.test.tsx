// Modified for Triune.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionShellResources } from "@/hooks/useSessionShellResources";
import type * as ShellResourcesModule from "@/hooks/useSessionShellResources";
import { useChatActivity, type ChatActivityEntry } from "@/hooks/useChatActivity";
import { useChildSessionTree, type ChildSessionInfo } from "@/hooks/useChildSessions";
import type * as Notifications from "@/lib/notifications";
import { toast, getNotificationSnapshot } from "@/lib/notifications";
import { useNativeChildCapabilities } from "@/hooks/useNativeChildCapabilities";
import { authenticatedFetch } from "@/lib/identity";
import { WorkbenchProvider } from "@/workbench/WorkbenchContext";
import {
  ChatActivityPanel,
  ActivityNavigation,
  type ChatActivityPanelProps,
} from "./ChatActivityPanel";

vi.mock("@/hooks/useSessionShellResources", async (original) => ({
  ...(await original<typeof ShellResourcesModule>()),
  useSessionShellResources: vi.fn(),
}));
vi.mock("@/hooks/useChatActivity", () => ({ useChatActivity: vi.fn() }));
vi.mock("@/hooks/useNativeChildCapabilities", () => ({ useNativeChildCapabilities: vi.fn() }));
vi.mock("@/hooks/useChildSessions", () => ({
  useChildSessionTree: vi.fn(),
  childSessionsQueryKey: (id: string) => ["conversation", id, "child_sessions"],
}));
vi.mock("@/lib/notifications", async (original) => ({
  ...(await original<typeof Notifications>()),
  toast: { error: vi.fn() },
}));
vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
  getCurrentUserId: () => "activity-test-viewer",
}));
vi.mock("@/components/blocks/PeerMessage", () => ({ PeerMessage: () => <div>Peer message</div> }));
vi.mock("./SubagentsGraphView", () => ({
  SubagentsGraphView: ({ rootSessionId }: { rootSessionId: string }) => (
    <div>Graph for {rootSessionId}</div>
  ),
}));

const query = vi.mocked(useChatActivity);
const refetch = vi.fn();
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ChatActivityPanel conversationId="selected-chat" rootSessionId="root-chat" {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
function stopByMouse(name: string) {
  const pill = screen.getByRole("button", { name: `Actions for ${name}` });
  fireEvent.pointerDown(pill, { pointerType: "mouse", button: 0 });
  fireEvent.click(pill, { detail: 1 });
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
  vi.mocked(useSessionShellResources).mockReturnValue({
    data: undefined,
    error: null,
    isLoading: false,
  } as ReturnType<typeof useSessionShellResources>);
  agents([]);
  vi.mocked(useNativeChildCapabilities).mockReturnValue({
    data: undefined,
    error: null,
  } as ReturnType<typeof useNativeChildCapabilities>);
  activity([]);
});
afterEach(() => {
  cleanup();
  client.clear();
});

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
  expect(
    agentRows.map((row) => row.querySelector(".min-w-0.flex-1")?.firstElementChild?.textContent),
  ).toEqual(["Failed agent", "James", "Older"]);
  expect(agentRows[0]).toHaveTextContent("Failed");
  expect(agentRows[1]).toHaveTextContent("Completed");
  const shellRows = within(screen.getByRole("list", { name: "Shells" })).getAllByRole("listitem");
  expect(
    shellRows.map((row) => row.querySelector(".min-w-0.flex-1")?.firstElementChild?.textContent),
  ).toEqual(["old shell", "idle shell", "bash", "lost shell"]);
  expect(shellRows[3]).toHaveTextContent("Disconnected");
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
  expect(useSessionShellResources).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  expect(screen.getByRole("region", { name: "Agents" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "Shells" })).not.toBeInTheDocument();
});

it("renders Markdown descriptions outside the opening button", async () => {
  agents([
    child({
      task_summary:
        "Inspect **dispatches** and `reports` with [context](https://example.test/context).",
    }),
  ]);
  const open = vi.fn();
  render(panel({ onOpenAgent: open }));
  const row = screen.getByRole("listitem");
  expect(within(row).getByText("dispatches")).toHaveClass("font-semibold");
  expect(within(row).getByText("reports").closest("code")).not.toBeNull();
  const link = within(row).getByRole("link", { name: "context" });
  expect(link.closest("button")).toBeNull();
  fireEvent.click(link);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(within(row).getByRole("button", { name: "James" }));
  expect(open).toHaveBeenCalledOnce();
});

it("restores the selected category after retirement without sharing it with another view", () => {
  const first = render(panel({ viewId: "retirement-category" }));
  fireEvent.click(screen.getByRole("button", { name: "Shells" }));
  first.unmount();
  const restored = render(panel({ viewId: "retirement-category" }));
  expect(screen.getByRole("button", { name: "Shells" })).toHaveAttribute("aria-pressed", "true");
  restored.rerender(panel({ viewId: "separate-category" }));
  expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
});

it("opens the named child through its row without a redundant Open action or inspector", () => {
  const agent = child({ busy: false, current_task_status: "completed" });
  agents([agent]);
  const open = vi.fn();
  render(panel({ onOpenAgent: open }));
  fireEvent.click(screen.getByRole("button", { name: "James" }));
  expect(screen.queryByRole("button", { name: "Open James" })).toBeNull();
  fireEvent.click(screen.getByRole("listitem").querySelector("[data-resource-row]")!);
  expect(open.mock.calls).toEqual([[agent], [agent]]);
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
  expect(screen.getByRole("listitem").querySelector("[data-resource-row]")).toHaveClass(
    "ring-ring",
  );
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

it("gates activity queries by visibility and removes unrelated menu entries", () => {
  const view = render(panel());
  const menu = options();
  expect(menu.queryByRole("menuitemradio", { name: "Messages" })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: "History coverage" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  view.rerender(panel({ active: false }));
  expect(query).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  expect(useChildSessionTree).toHaveBeenLastCalledWith("root-chat", false);
  view.rerender(panel());
  expect(query).toHaveBeenLastCalledWith("selected-chat", { enabled: true });
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
    fireEvent.click(screen.getByRole("button", { name: "bash" }));
    expect(open).toHaveBeenCalledWith({
      sessionId: "origin-chat",
      terminalId: "terminal_bash_a",
      workspaceId: "workspace",
      retainedOnly: true,
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
  fireEvent.click(screen.getByRole("button", { name: "pnpm test" }));
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
    name: "old command",
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
  fireEvent.click(screen.getByRole("button", { name: "old command" }));
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({ activity: expect.objectContaining({ entries: [old, oldCommand] }) }),
  );
  fireEvent.click(screen.getByRole("button", { name: "new command" }));
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      activity: expect.objectContaining({ entries: [recent, newCommand] }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "other bash" }));
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionId: "another-chat",
      activity: expect.objectContaining({ entries: [other] }),
    }),
  );
});

it("keeps internal capture diagnostics out of the view and menu", () => {
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
  expect(screen.queryByText("Exit timestamps are unavailable.")).toBeNull();
  expect(screen.queryByText("History incomplete")).not.toBeInTheDocument();
  expect(options().queryByRole("menuitem", { name: "History coverage" })).toBeNull();
  expect(screen.queryByRole("region", { name: "History coverage" })).toBeNull();
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
  expect(screen.queryByRole("button", { name: "Actions for James" })).not.toBeInTheDocument();
  view.rerender(panel({ onOpenAgent: open, onStopAgent: stop, canStopAgent: () => true }));
  expect(screen.queryByRole("button", { name: "Actions for Done agent" })).not.toBeInTheDocument();
  stopByMouse("James");
  await waitFor(() =>
    expect(getNotificationSnapshot().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Could not stop agent",
          description: "Refresh agent controls and try again.",
        }),
      ]),
    ),
  );
  expect(toast.error).not.toHaveBeenCalled();
  expect(document.body).not.toHaveTextContent("Native stop unavailable");
  expect(stop).toHaveBeenCalledWith(running);
  expect(open).not.toHaveBeenCalled();
});

it("stops the captured registered launch through the live service without opening a tab", async () => {
  const resourceUrl = "/v1/sessions/selected-chat/resources/shells/registered_terminal/launch-one";
  vi.mocked(useSessionShellResources).mockReturnValue({
    data: {
      data: [
        {
          source: "registered_terminal",
          resource_id: "launch-one",
          terminal_id: "slot-reused",
          status: "running",
          command: "same command",
          can_stop: true,
          resource_url: resourceUrl,
          stop_url: `${resourceUrl}/stop`,
          stop_method: "POST",
        },
      ],
    },
    error: null,
  } as ReturnType<typeof useSessionShellResources>);
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(null, { status: 204 }));
  const open = vi.fn();
  render(panel({ onOpenTerminal: open }));
  stopByMouse("same command");
  await waitFor(() =>
    expect(authenticatedFetch).toHaveBeenCalledWith(`${resourceUrl}/stop`, { method: "POST" }),
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
  expect(screen.queryByRole("button", { name: "Actions for James" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Actions for Managed" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Actions for Settled" })).not.toBeInTheDocument();
  vi.mocked(useNativeChildCapabilities).mockReturnValue({
    data: { version: 1, state: "running", can_reply: false, can_steer: false, can_stop: true },
    error: null,
  } as ReturnType<typeof useNativeChildCapabilities>);
  view.rerender(panel(props));
  stopByMouse("James");
  await waitFor(() => expect(stop).toHaveBeenCalledWith(native));
  view.rerender(panel({ ...props, active: false }));
  expect(useNativeChildCapabilities).toHaveBeenLastCalledWith("james", false);
  expect(screen.queryByRole("button", { name: "Actions for James" })).not.toBeInTheDocument();
  vi.mocked(useNativeChildCapabilities).mockReturnValue({
    data: { can_stop: true },
    error: new Error("Capability refresh failed"),
  } as ReturnType<typeof useNativeChildCapabilities>);
  view.rerender(panel(props));
  expect(screen.queryByRole("button", { name: "Actions for James" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "James" })).toBeVisible();
});

it("focuses a native shell once per link request and preserves the selected source", () => {
  const consume = vi.fn();
  const shellResources = [
    {
      source: "codex_native" as const,
      resource_id: "item-a",
      command: "echo exact-command",
      output_preview: "saved output",
      status: "completed",
    },
  ];
  const props = {
    shellResources,
    focusShellId: "codex_native:item-a",
    linkRequestId: "first",
    onConsumeLinkIntent: consume,
  };
  const view = render(panel(props));
  expect(screen.getByRole("button", { name: "Shells", pressed: true })).toBeVisible();
  expect(screen.getByText("saved output")).toBeVisible();
  expect(consume).toHaveBeenCalledOnce();
  view.rerender(panel(props));
  expect(consume).toHaveBeenCalledOnce();
  view.rerender(panel({ ...props, linkRequestId: "second" }));
  expect(consume).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenLastCalledWith("selected-chat", { enabled: true });
});

it("shares agent navigation controls and targets the originating Orchestration", () => {
  agents([child()]);
  const openView = vi.fn();
  const openAgent = vi.fn();
  render(
    <WorkbenchProvider value={{ openView, openConversation: vi.fn() }}>
      {panel({ onOpenAgent: openAgent })}
    </WorkbenchProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open chat beside · James" }));
  expect(openAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "james" }));
  expect(openView).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show James in Orchestration" }));
  expect(openView).toHaveBeenCalledWith(
    expect.objectContaining({
      source: { kind: "chat", conversationId: "selected-chat" },
      focusAgentId: "james",
      linkRequestId: expect.any(String),
    }),
    { beside: true },
  );
});

it("deduplicates service and ledger launches by identity and keeps identical commands separate", () => {
  activity([
    entry({ id: "launch-one", session_id: "selected-chat", name: "shell one" }),
    entry({ id: "launch-two", session_id: "selected-chat", name: "shell two" }),
  ]);
  vi.mocked(useSessionShellResources).mockReturnValue({
    data: {
      data: ["launch-one", "launch-two"].map((resource_id) => ({
        source: "registered_terminal",
        session_id: "selected-chat",
        resource_id,
        terminal_id: "reused-slot",
        command: "same command",
        status: "running",
        can_open: true,
        resource_url: `/v1/sessions/selected-chat/resources/shells/registered_terminal/${resource_id}`,
      })),
    },
    error: null,
  } as ReturnType<typeof useSessionShellResources>);
  const open = vi.fn();
  render(panel({ onOpenTerminal: open }));
  const rows = within(screen.getByRole("list", { name: "Shells" })).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  fireEvent.click(
    within(rows[1]).getByRole("button", { name: "Open shell beside · same command" }),
  );
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "selected-chat",
      terminalId: "registered_terminal:launch-two",
      shellResource: expect.objectContaining({
        resource_id: "launch-two",
        terminal_id: "reused-slot",
      }),
      retainedOnly: true,
    }),
  );
  expect(useSessionShellResources).toHaveBeenLastCalledWith("selected-chat", { enabled: true });
});

it("deduplicates native executions by a known activity alias and retains an unmapped equal command", () => {
  activity([
    entry({
      id: "command_known_one",
      kind: "command",
      terminal_id: null,
      session_id: "selected-chat",
      name: "same command",
    }),
    entry({
      id: "command_known_two",
      kind: "command",
      terminal_id: null,
      session_id: "selected-chat",
      name: "same command",
    }),
    entry({
      id: "command_unmapped",
      kind: "command",
      terminal_id: null,
      session_id: "selected-chat",
      name: "same command",
    }),
  ]);
  vi.mocked(useSessionShellResources).mockReturnValue({
    data: {
      data: ["one", "two"].map((id) => ({
        source: "codex_native",
        resource_id: id,
        activity_id: `command_known_${id}`,
        command: "same command",
        status: "completed",
      })),
    },
    error: null,
  } as ReturnType<typeof useSessionShellResources>);
  render(panel());
  const rows = within(screen.getByRole("list", { name: "Shells" })).getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveAttribute("data-shell-id", "codex_native:one");
  expect(rows[1]).toHaveAttribute("data-shell-id", "codex_native:two");
  expect(rows[2]).toHaveAttribute("data-shell-id", "command_unmapped");
});

it.each([
  ["exited", 0, "Completed"],
  ["exited", 2, "Failed"],
  ["exited", undefined, "Ended"],
  ["disconnected", undefined, "Disconnected"],
] as const)("uses shared shell outcomes for legacy %s / %s", (state, exit_status, label) => {
  activity([entry({ state, exit_status })]);
  render(panel());
  expect(
    within(screen.getByRole("list", { name: "Shells" })).getByRole("status", { name: label }),
  ).toBeVisible();
});

it.each([
  ["stopped", -1, "Stopped"],
  ["completed", undefined, "Ended"],
  ["completed", 0, "Completed"],
  ["completed", 1, "Failed"],
  ["declined", undefined, "Declined"],
  ["killed", undefined, "Ended"],
] as const)(
  "uses shared shell outcomes and never offers Stop for %s / %s",
  (status, exit_code, label) => {
    render(
      panel({
        shellResources: [
          {
            source: "codex_native",
            resource_id: "one",
            command: "Retained command",
            status,
            exit_code,
            can_stop: true,
          },
        ],
      }),
    );
    expect(screen.getByRole("status", { name: label })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Actions for Retained command" })).toBeNull();
  },
);

it("deduplicates safe shell notices per source, preserves rows and retires Refresh when hidden", async () => {
  const refresh = vi.fn();
  const observation = {
    data: {
      data: [
        {
          source: "codex_native",
          resource_id: "one",
          command: "Retained shell",
          status: "disconnected",
        },
      ],
      warning: "runner_token_secret",
    },
    error: null,
    refetch: refresh,
  } as unknown as ReturnType<typeof useSessionShellResources>;
  vi.mocked(useSessionShellResources).mockReturnValue(observation);
  const view = render(panel());
  const notice = () =>
    getNotificationSnapshot().entries.find(
      (noticeEntry) => String(noticeEntry.id).startsWith("activity-shells:") && noticeEntry.visible,
    );
  expect(notice()).toMatchObject({
    title: "Shell runtime offline",
    action: expect.objectContaining({ label: "Refresh" }),
  });
  const id = notice()!.id;
  expect(screen.getByText("Retained shell")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body).not.toHaveTextContent("runner_token_secret");
  view.rerender(panel());
  expect(
    getNotificationSnapshot().entries.filter((noticeEntry) => noticeEntry.id === id),
  ).toHaveLength(1);
  const action = notice()!.action as Notifications.Action;
  action.onClick({} as Parameters<typeof action.onClick>[0]);
  expect(refresh).toHaveBeenCalledOnce();
  vi.mocked(useSessionShellResources).mockReturnValue({
    ...observation,
    error: new Error("runner_token_secret"),
  } as ReturnType<typeof useSessionShellResources>);
  view.rerender(panel());
  expect(notice()).toMatchObject({
    id,
    title: "Shell controls unavailable",
    description: "Could not refresh shell history. Try again.",
  });
  expect(JSON.stringify(notice())).not.toContain("runner_token_secret");
  view.rerender(panel({ active: false }));
  expect(
    getNotificationSnapshot().entries.find((noticeEntry) => noticeEntry.id === id),
  ).toMatchObject({
    visible: false,
    action: undefined,
  });
});

it("retains genuine navigation hrefs and leaves modified clicks to the browser", () => {
  const open = vi.fn();
  const orchestration = vi.fn();
  render(
    <MemoryRouter>
      <ActivityNavigation
        name="Exact chat"
        openHref="/c/captured%2Fchat"
        orchestrationHref="/c/parent?panel=activity&focusAgentId=child"
        onOpen={open}
        onOrchestration={orchestration}
      />
    </MemoryRouter>,
  );
  const chat = screen.getByRole("link", { name: "Open chat beside · Exact chat" });
  const activityLink = screen.getByRole("link", { name: "Show Exact chat in Orchestration" });
  expect(chat).toHaveAttribute("href", "/c/captured%2Fchat");
  expect(activityLink).toHaveAttribute("href", "/c/parent?panel=activity&focusAgentId=child");
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
    fireEvent.click(chat, { [modifier]: true });
    fireEvent.click(activityLink, { [modifier]: true });
  }
  expect(open).not.toHaveBeenCalled();
  expect(orchestration).not.toHaveBeenCalled();
  fireEvent.click(chat);
  fireEvent.click(activityLink);
  expect(open).toHaveBeenCalledOnce();
  expect(orchestration).toHaveBeenCalledOnce();
});
