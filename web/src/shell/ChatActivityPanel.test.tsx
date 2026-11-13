// Modified for Triune.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatActivity, type ChatActivityEntry } from "@/hooks/useChatActivity";
import { useChildSessionTree, type ChildSessionInfo } from "@/hooks/useChildSessions";
import { usePeerMessages } from "@/hooks/usePeerMessages";
import { useSession } from "@/hooks/useSession";
import { ChatActivityPanel, type ChatActivityPanelProps } from "./ChatActivityPanel";

vi.mock("@/hooks/useChatActivity", () => ({ useChatActivity: vi.fn() }));
vi.mock("@/hooks/useChildSessions", () => ({ useChildSessionTree: vi.fn() }));
vi.mock("@/hooks/usePeerMessages", () => ({
  usePeerMessages: vi.fn(),
  peerActivityKey: (message: { id: string }) => message.id,
}));
vi.mock("@/hooks/useSession", () => ({ useSession: vi.fn() }));
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
function details() {
  fireEvent.click(options().getByRole("menuitem", { name: "Details" }));
  return within(screen.getByRole("dialog"));
}

beforeEach(() => {
  vi.clearAllMocks();
  agents([]);
  activity([]);
  vi.mocked(useSession).mockReturnValue({ session: null, isLoading: false, error: null });
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

it("merges active agents and open shells by observed last activity, with no root hero or permanent history groups", () => {
  agents([
    child(),
    child({ id: "old-agent", tool: "Old agent", busy: false, current_task_status: "completed" }),
    child({ id: "failed", tool: "Failed agent", busy: false, current_task_status: "failed" }),
  ]);
  activity([
    entry({ started_at: 100 }),
    entry({ id: "idle", name: "idle shell", state: "idle", started_at: 300 }),
    entry({ id: "past", name: "old shell", state: "exited" }),
    entry({ id: "lost", name: "lost shell", state: "unknown" }),
  ]);
  const { container } = render(panel());
  const rows = within(screen.getByRole("list", { name: "Orchestration" })).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    "idle shellIdle · shell open",
    "James: Check navigationRunning",
    "bashRunning",
  ]);
  expect(container.querySelectorAll(".workspace-control-header")).toHaveLength(1);
  expect(container.querySelectorAll(".density-row")).toHaveLength(3);
  expect(within(container.querySelector("header")!).getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByTestId("subagent-main-row")).not.toBeInTheDocument();
  for (const text of [
    "Needs attention",
    "Recent",
    "Live",
    "Past",
    "old shell",
    "Old agent",
    "Failed agent",
    "lost shell",
  ])
    expect(screen.queryByText(text)).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Messages" })).not.toBeInTheDocument();
});

it("uses newer command activity to order an existing open shell", () => {
  agents([child()]);
  activity([
    entry({ started_at: 100 }),
    entry({
      id: "cmd",
      kind: "command",
      name: "git status",
      state: "exited",
      started_at: 300,
      ended_at: 350,
    }),
  ]);
  render(panel());
  expect(
    within(screen.getByRole("list", { name: "Orchestration" })).getAllByRole("listitem")[0],
  ).toHaveTextContent("bash");
  expect(screen.queryByText("git status")).not.toBeInTheDocument();
});

it("gates all queries by visibility, peer polling by Messages, and retains the filter", () => {
  const view = render(panel());
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  choose("Messages");
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: true });
  view.rerender(panel({ active: false }));
  expect(query).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  expect(useChildSessionTree).toHaveBeenLastCalledWith("root-chat", false);
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  view.rerender(panel({ active: true }));
  expect(options().getByRole("menuitemradio", { name: "Messages" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  choose("All");
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
});

it("filters the same flat list without inserting empty sections", () => {
  agents([child()]);
  activity([entry()]);
  render(panel());
  choose("Shells");
  expect(screen.queryByText("James")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "bash" })).toBeVisible();
  choose("Agents");
  expect(screen.getByText("James")).toBeVisible();
  expect(screen.queryByRole("button", { name: "bash" })).not.toBeInTheDocument();
});

it.each(["completed", "failed"])(
  "inspects a selected %s agent omitted from the active list",
  (state) => {
    agents([child({ busy: false, current_task_status: state })]);
    const { container } = render(panel({ focusAgentId: "james" }));
    expect(container.querySelector('ul[aria-label="Orchestration"]')?.children).toHaveLength(0);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("heading", { name: "James" })).toBeVisible();
    expect(dialog.getByText(state === "completed" ? "Completed" : "Failed")).toBeVisible();
    expect(dialog.getByRole("link", { name: "Open conversation" })).toHaveAttribute(
      "href",
      "/c/james",
    );
  },
);

it("resolves an explicit target absent from the tree and reopens it for a new request token", () => {
  const view = render(panel({ focusAgentId: "older-agent", linkRequestId: "first" }));
  expect(useSession).toHaveBeenCalledWith("older-agent");
  expect(screen.getByRole("dialog")).toHaveTextContent("Session: older-agent");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(panel({ focusAgentId: "older-agent", linkRequestId: "second" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Session: older-agent");
  view.rerender(panel({ focusAgentId: "older-agent", linkRequestId: "second", active: false }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("opens the exact workspace-owned live terminal used by another chat", () => {
  activity([entry({ owner_kind: "workspace", owner_id: "workspace", workspace_id: "workspace" })]);
  const open = vi.fn();
  render(panel({ onOpenTerminal: open }));
  fireEvent.click(screen.getByRole("button", { name: "bash" }));
  expect(open).toHaveBeenCalledWith({
    sessionId: "origin-chat",
    terminalId: "terminal_bash_a",
    workspaceId: "workspace",
  });
});

it.each(["exited", "unknown", "disconnected"] as const)(
  "keeps %s shells in explicit details and inspects retained output without attaching",
  (state) => {
    activity([
      entry({
        state,
        output: "Saved output",
        exit_status: 0,
        started_at: "2026-11-09T10:00:00Z",
        ended_at: "2026-11-09T10:02:00Z",
        parent_agent_id: "child-agent",
      }),
    ]);
    const open = vi.fn();
    render(panel({ onOpenTerminal: open }));
    expect(screen.queryByRole("button", { name: "bash" })).not.toBeInTheDocument();
    fireEvent.click(details().getByRole("button", { name: "bash" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Saved output")).toBeVisible();
    expect(dialog.getByText(new Date("2026-11-09T10:02:00Z").toLocaleString())).toBeVisible();
    expect(dialog.getByText("child-agent")).toBeVisible();
    expect(dialog.getByText("0")).toBeVisible();
    expect(open).not.toHaveBeenCalled();
  },
);

it("keeps separate terminal launches and assigns commands by launch time", () => {
  activity([
    entry({
      id: "old-launch",
      name: "previous bash",
      state: "exited",
      started_at: 100,
      ended_at: 200,
      output: "Previous process",
    }),
    entry({ id: "new-launch", started_at: 300 }),
    entry({
      id: "old-cmd",
      kind: "command",
      name: "old command",
      state: "exited",
      started_at: 150,
    }),
    entry({ id: "new-cmd", kind: "command", name: "new command", started_at: 350 }),
  ]);
  render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Inspect bash" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("new command");
  expect(screen.queryByText("old command")).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
  fireEvent.click(details().getByRole("button", { name: "previous bash" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("old command");
  expect(screen.queryByText("new command")).not.toBeInTheDocument();
});

it("does not merge identical terminal IDs from different sessions", () => {
  activity([entry(), entry({ id: "other", session_id: "other-chat", name: "other bash" })]);
  const open = vi.fn();
  render(panel({ onOpenTerminal: open }));
  fireEvent.click(screen.getByRole("button", { name: "other bash" }));
  expect(open).toHaveBeenCalledWith({ sessionId: "other-chat", terminalId: "terminal_bash_a" });
});

it("keeps bare commands inspectable in details without inventing live shells", () => {
  activity([
    entry({
      id: "bare",
      kind: "command",
      terminal_id: null,
      name: "pnpm test",
      state: "exited",
      output: "Tests passed",
    }),
  ]);
  const open = vi.fn();
  render(panel({ onOpenTerminal: open }));
  expect(screen.queryByText("pnpm test")).not.toBeInTheDocument();
  fireEvent.click(details().getByRole("button", { name: "Commands without a terminal" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("pnpm test");
  expect(screen.getByRole("dialog")).toHaveTextContent("Tests passed");
  expect(open).not.toHaveBeenCalled();
});

it("keeps coverage explanations in details, retaining only the incomplete-history signal", () => {
  activity([], {
    data: { data: [], coverage: "partial", warning: "Native history is not retained." },
  });
  render(panel());
  expect(screen.getByText("History incomplete")).toBeVisible();
  expect(screen.queryByText(/History coverage/)).not.toBeInTheDocument();
  expect(screen.queryByText("Native history is not retained.")).not.toBeInTheDocument();
  const dialog = details();
  expect(dialog.getByText(/History coverage: partial/)).toBeVisible();
  expect(dialog.getByText("Native history is not retained.")).toBeVisible();
});

it("preserves graph navigation as an explicit view option", async () => {
  render(panel());
  choose("Graph view");
  expect(await screen.findByText("Graph for root-chat")).toBeVisible();
  choose("List view");
  expect(screen.getByRole("list", { name: "Orchestration" })).toBeVisible();
});

it("retains selected output on refresh and closes it on chat changes", () => {
  activity([entry({ output: "Retained output" })]);
  const view = render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Inspect bash" }));
  activity([entry({ output: "New output" })]);
  view.rerender(panel());
  expect(screen.getByRole("dialog")).toHaveTextContent("New output");
  view.rerender(panel({ conversationId: "other" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
