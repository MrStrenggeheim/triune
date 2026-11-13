// Modified for Triune.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatActivity, type ChatActivityEntry } from "@/hooks/useChatActivity";
import { useChildSessions } from "@/hooks/useChildSessions";
import { usePeerMessages, type PeerActivityMessage } from "@/hooks/usePeerMessages";
import type * as UseChildSessionsModule from "@/hooks/useChildSessions";
import { ChatActivityPanel } from "./ChatActivityPanel";

vi.mock("@/hooks/useChatActivity", () => ({ useChatActivity: vi.fn() }));
vi.mock("@/hooks/usePeerMessages", () => ({
  usePeerMessages: vi.fn(),
  peerActivityKey: (message: PeerActivityMessage) => message.id,
}));
vi.mock("@/hooks/useChildSessions", async (original) => ({
  ...(await original<typeof UseChildSessionsModule>()),
  useChildSessions: vi.fn(),
}));
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ session: null }) }));
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
function activity(entries: ChatActivityEntry[], extra: Record<string, unknown> = {}) {
  query.mockReturnValue({
    data: { data: entries, coverage: "complete" },
    isLoading: false,
    error: null,
    refetch,
    ...extra,
  } as unknown as ReturnType<typeof useChatActivity>);
}
function panel(conversationId = "selected-chat", onOpenTerminal = vi.fn(), active = true) {
  return (
    <MemoryRouter>
      <ChatActivityPanel
        conversationId={conversationId}
        rootSessionId="root-chat"
        active={active}
        onOpenTerminal={onOpenTerminal}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useChildSessions).mockReturnValue({ children: [], isLoading: false, error: null });
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

it("retains its filter while polling is disabled across A/B/A", () => {
  activity([entry({ output: "Retained command output" })]);
  const open = vi.fn();
  const view = render(panel("selected-chat", open));
  fireEvent.click(screen.getByRole("button", { name: "Shells" }));
  view.rerender(panel("selected-chat", open, false));
  expect(query).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  expect(usePeerMessages).toHaveBeenLastCalledWith("selected-chat", { enabled: false });
  view.rerender(panel("selected-chat", open, true));
  expect(screen.getByRole("button", { name: "Shells" })).toHaveAttribute("aria-pressed", "true");
  expect(query).toHaveBeenLastCalledWith("selected-chat", { enabled: true });
});

it("uses one shared header and filters while preserving the main agent navigation", () => {
  activity([entry()]);
  const { container } = render(panel());
  expect(container.querySelectorAll(".workspace-control-header")).toHaveLength(1);
  expect(query).toHaveBeenCalledWith("selected-chat", { enabled: true });
  expect(screen.getByTestId("subagent-main-row")).toHaveAttribute("href", "/c/root-chat");
  fireEvent.click(screen.getByRole("button", { name: "Shells" }));
  expect(screen.queryByRole("region", { name: "Agents" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Shells" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  expect(screen.queryByRole("region", { name: "Shell activity" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Agents" })).toBeVisible();
});

it("preserves the graph feature through the combined header and filters", async () => {
  render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Graph view" }));
  expect(await screen.findByText("Graph for root-chat")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Shells" }));
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(screen.getByText("Graph for root-chat")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  expect(screen.getByTestId("subagent-main-row")).toBeVisible();
});

it("puts running and idle shells first, keeps uncertain state explicit, and collapses past shells", () => {
  activity([
    entry({ id: "past", terminal_id: "past", name: "old shell", state: "exited" }),
    entry({ id: "lost", terminal_id: "lost", name: "lost shell", state: "disconnected" }),
    entry({ id: "unknown", terminal_id: "unknown", name: "unknown shell", state: "unknown" }),
    entry({ id: "idle", terminal_id: "idle", name: "idle shell", state: "idle" }),
    entry(),
  ]);
  const { container } = render(panel());
  expect(screen.queryByRole("button", { name: "old shell" })).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: "Live shells" })).getByText("idle shell"),
  ).toBeVisible();
  expect(screen.getByText("Idle · shell open")).toBeVisible();
  expect(screen.getByText("Disconnected · availability unknown")).toBeVisible();
  expect(screen.getByText("State unknown")).toBeVisible();
  expect(
    [...container.querySelectorAll('section[aria-label$="shells"]')].map((el) =>
      el.getAttribute("aria-label"),
    ),
  ).toEqual(["Live shells", "Unavailable shells"]);
  fireEvent.click(screen.getByRole("button", { name: "Past (1)" }));
  expect(screen.getByRole("button", { name: "old shell" })).toBeVisible();
});

it("opens the original live terminal using both IDs even for workspace usage or another chat", () => {
  activity([entry({ owner_kind: "workspace", owner_id: "workspace", workspace_id: "workspace" })]);
  const open = vi.fn();
  render(panel("selected-chat", open));
  fireEvent.click(screen.getByRole("button", { name: "bash" }));
  expect(open).toHaveBeenCalledWith({
    sessionId: "origin-chat",
    terminalId: "terminal_bash_a",
    workspaceId: "workspace",
  });
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
  expect(screen.getByText("Workspace terminal · used by this chat")).toBeVisible();
});

it("opens ended shells as retained output with timestamps and exit status without attaching", () => {
  activity([
    entry({
      state: "exited",
      output: "Saved output",
      exit_status: 0,
      started_at: "2026-11-09T10:00:00Z",
      ended_at: "2026-11-09T10:02:00Z",
      parent_agent_id: "child-agent",
    }),
  ]);
  const open = vi.fn();
  render(panel("selected-chat", open));
  fireEvent.click(screen.getByRole("button", { name: "Past (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "bash" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("Saved output")).toBeVisible();
  expect(dialog.getByText(new Date("2026-11-09T10:02:00Z").toLocaleString())).toBeVisible();
  expect(dialog.getByText("child-agent")).toBeVisible();
  expect(dialog.getByText("0")).toBeVisible();
  expect(open).not.toHaveBeenCalled();
});

it.each(["unknown", "disconnected"] as const)("never attaches to a %s shell", (state) => {
  activity([entry({ state })]);
  const open = vi.fn();
  render(panel("selected-chat", open));
  fireEvent.click(screen.getByRole("button", { name: "bash" }));
  expect(
    within(screen.getByRole("dialog")).getByText("Retained output unavailable."),
  ).toBeVisible();
  expect(open).not.toHaveBeenCalled();
});

it.each([false, true])(
  "shows live attachment unavailability when callback or terminal ID is absent (%s)",
  (missingId) => {
    activity([entry(missingId ? { terminal_id: null } : {})]);
    render(
      <MemoryRouter>
        <ChatActivityPanel
          conversationId="chat"
          rootSessionId="root"
          onOpenTerminal={missingId ? vi.fn() : undefined}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
    expect(screen.getByText("Live terminal unavailable here.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "bash" }));
    expect(screen.getByRole("dialog")).toBeVisible();
  },
);

it("nests commands beneath their real terminal and groups bare commands without fabricated shells", () => {
  activity([
    entry({ id: "command1", kind: "command", name: "git status", state: "exited" }),
    entry(),
    entry({
      id: "command2",
      kind: "command",
      terminal_id: null,
      name: "pnpm test",
      state: "exited",
    }),
    entry({ id: "command3", kind: "command", terminal_id: null, name: "pwd", state: "exited" }),
  ]);
  render(panel());
  expect(screen.queryByText("git status")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
  fireEvent.click(screen.getByRole("button", { name: "Commands (1)" }));
  expect(screen.getByText("git status")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Past (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
  fireEvent.click(screen.getByRole("button", { name: "Commands (2)" }));
  expect(screen.getByText("pnpm test")).toBeVisible();
  expect(screen.getByText("pwd")).toBeVisible();
});

it("does not merge identical terminal IDs from different sessions", () => {
  activity([entry(), entry({ id: "other", session_id: "other-chat", name: "other bash" })]);
  const open = vi.fn();
  render(panel("selected-chat", open));
  fireEvent.click(screen.getByRole("button", { name: "other bash" }));
  expect(open).toHaveBeenCalledWith({ sessionId: "other-chat", terminalId: "terminal_bash_a" });
  expect(screen.getByRole("button", { name: "bash" })).toBeVisible();
});

it("keeps separate launches of a reused terminal ID and assigns commands by launch time", () => {
  activity([
    entry({
      id: "old-launch",
      name: "previous bash",
      state: "exited",
      started_at: 100,
      ended_at: 200,
      output: "Previous process",
    }),
    entry({ id: "current-launch", started_at: 300 }),
    entry({
      id: "old-command",
      kind: "command",
      name: "old command",
      state: "exited",
      started_at: 150,
    }),
    entry({ id: "current-command", kind: "command", name: "current command", started_at: 350 }),
  ]);
  const open = vi.fn();
  render(panel("selected-chat", open));
  const live = within(screen.getByRole("region", { name: "Live shells" }));
  fireEvent.click(live.getByRole("button", { name: "Expand activity" }));
  fireEvent.click(live.getByRole("button", { name: "Commands (1)" }));
  expect(live.getByText("current command")).toBeVisible();
  expect(live.queryByText("old command")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Past (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "previous bash" }));
  expect(screen.getByText("Previous process")).toBeVisible();
  expect(within(screen.getByRole("dialog")).getByText("old command")).toBeVisible();
  expect(open).not.toHaveBeenCalled();
});

it("does not invent an attachable shell for command-only activity", () => {
  activity([entry({ kind: "command", name: "running command" })]);
  const open = vi.fn();
  render(panel("selected-chat", open));
  fireEvent.click(screen.getByRole("button", { name: "Recorded shell commands" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(open).not.toHaveBeenCalled();
});

it("retains expansion during background updates and closes old output on chat changes", () => {
  activity([entry({ id: "past", state: "exited", output: "old chat output" })]);
  const { rerender } = render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Past (1)" }));
  activity([entry({ id: "past", state: "exited", output: "old chat output", exit_status: 1 })]);
  rerender(panel());
  expect(screen.getByRole("button", { name: "bash" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "bash" }));
  expect(screen.getByText("old chat output")).toBeVisible();
  activity([]);
  rerender(panel("new-chat"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("old chat output")).not.toBeInTheDocument();
});

it("shows coverage limits, warnings, and empty chat usage without listing workspace inventory", () => {
  activity([], {
    data: { data: [], coverage: "partial", warning: "Native history is not retained." },
  });
  render(panel());
  expect(screen.getByText(/History coverage: partial/)).toBeVisible();
  expect(screen.getByText("Native history is not retained.")).toBeVisible();
  expect(screen.getByText("No shell activity recorded for this chat.")).toBeVisible();
});

it("renders the backend's structured retention limits and unavailable capture", () => {
  activity([], {
    data: {
      data: [],
      coverage: {
        terminals: "unavailable",
        history: "bounded",
        output: "bounded_snapshots",
        non_tty_commands: "unavailable",
        native_vendor_shells: "unknown",
        max_entries: 128,
        max_output_bytes: 8192,
      },
    },
  });
  render(panel());
  expect(
    screen.getByText("Up to 128 retained entries; 8192 bytes per output snapshot."),
  ).toBeVisible();
  expect(screen.getByText("Current terminal activity unavailable.")).toBeVisible();
});

it.each([false, true])("shows refresh errors and allows retry, with cached rows: %s", (cached) => {
  activity([entry()], { ...(cached ? {} : { data: undefined }), error: new Error("offline") });
  render(panel());
  expect(
    screen.getByText(cached ? /could not be refreshed/ : "Shell activity unavailable."),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "bash" }) !== null).toBe(cached);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refetch).toHaveBeenCalledOnce();
});

it("keeps agent navigation visible while loading shell activity", () => {
  activity([], { data: undefined, isLoading: true });
  render(panel());
  expect(screen.getByText("Loading shell activity…")).toBeVisible();
  expect(screen.getByTestId("subagent-main-row")).toBeVisible();
});

it("filters attributed incoming/outgoing messages and requests another page even when the first is empty", () => {
  const fetchNextPage = vi.fn();
  const messages: PeerActivityMessage[] = [
    {
      id: "incoming",
      direction: "incoming",
      communication: {
        kind: "peer",
        message_id: "incoming",
        source_conversation_id: "source-chat",
        source_title: "Researcher",
        destination_conversation_id: "selected-chat",
        delivery_state: "confirmed",
      },
      content: [{ type: "input_text", text: "The complete incoming text" }],
    },
    {
      id: "outgoing",
      direction: "outgoing",
      communication: {
        kind: "peer",
        message_id: "outgoing",
        source_conversation_id: "selected-chat",
        destination_conversation_id: "target-chat",
        delivery_state: "unknown",
      },
      content: [{ type: "input_text", text: "The complete outgoing text" }],
    },
  ];
  vi.mocked(usePeerMessages).mockReturnValue({
    messages,
    isLoading: false,
    error: null,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePeerMessages>);
  const rendered = render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Messages" }));
  expect(screen.queryByRole("region", { name: "Agents" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Shell activity" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "From Researcher" })).toHaveAttribute(
    "href",
    "/c/source-chat",
  );
  expect(screen.getByRole("link", { name: "Message to conversation" })).toHaveAttribute(
    "href",
    "/c/target-chat",
  );
  expect(screen.getByText("Unconfirmed")).toBeVisible();
  expect(screen.getByText("The complete incoming text")).toBeVisible();
  fireEvent.click(screen.getAllByRole("button", { name: "Expand activity" })[1]);
  expect(screen.getByText("Delivery")).toBeVisible();
  rendered.rerender(panel());
  expect(screen.getByRole("button", { name: "Collapse activity" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Load older outgoing messages" }));
  expect(fetchNextPage).toHaveBeenCalledOnce();
  vi.mocked(usePeerMessages).mockReturnValue({
    messages: [],
    isLoading: false,
    error: null,
    hasNextPage: true,
    fetchNextPage,
  } as unknown as ReturnType<typeof usePeerMessages>);
  rendered.rerender(panel());
  expect(screen.getByRole("button", { name: "Load older outgoing messages" })).toBeEnabled();
});

it("keeps incoming messages available when outbox inspection fails and exposes retry", () => {
  const retry = vi.fn();
  vi.mocked(usePeerMessages).mockReturnValue({
    messages: [],
    isLoading: false,
    error: new Error("Unavailable"),
    hasNextPage: false,
    refetch: retry,
  } as unknown as ReturnType<typeof usePeerMessages>);
  render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Messages" }));
  expect(screen.getByText(/Incoming messages reflect loaded conversation history/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
  expect(retry).toHaveBeenCalledOnce();
});
