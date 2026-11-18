import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type * as HostModule from "@/lib/host";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatActivity } from "@/hooks/useChatActivity";
import { useChildSessions, type ChildSessionInfo } from "@/hooks/useChildSessions";
import {
  useActivityConversationState,
  usePeerMessages,
  type PeerActivityMessage,
} from "@/hooks/usePeerMessages";
import { useViewerId } from "@/hooks/useViewerId";
import { createInitialConversationState } from "@/store/conversationState";
import { ConversationActivityDock, conversationActivityItems } from "./ConversationActivityDock";

vi.mock("@/hooks/useChatActivity", () => ({ useChatActivity: vi.fn() }));
vi.mock("@/hooks/useChildSessions", () => ({ useChildSessions: vi.fn() }));
vi.mock("@/hooks/usePeerMessages", () => ({
  usePeerMessages: vi.fn(),
  useActivityConversationState: vi.fn(),
  peerActivityKey: (message: PeerActivityMessage) => message.id,
}));
vi.mock("@/hooks/useViewerId", () => ({ useViewerId: vi.fn(() => "account") }));
vi.mock("@/lib/host", async (original) => ({
  ...(await original<typeof HostModule>()),
  getOmnigentServerIdentity: () => "server",
}));

const child = (patch: Partial<ChildSessionInfo> = {}): ChildSessionInfo => ({
  id: "child",
  title: "Research",
  task_summary: null,
  session_name: null,
  tool: null,
  current_task_status: "completed",
  busy: false,
  last_message_preview: "Completed result",
  pending_elicitations_count: 0,
  ...patch,
});
const peer: PeerActivityMessage = {
  id: "incoming",
  direction: "incoming",
  communication: {
    kind: "peer",
    message_id: "incoming",
    source_conversation_id: "sender",
    source_title: "Reviewer",
    destination_conversation_id: "chat",
    delivery_state: "confirmed",
  },
  content: [{ type: "input_text", text: "A useful result" }],
};
const dock = (conversationId: string | null = "chat") => (
  <MemoryRouter>
    <ConversationActivityDock conversationId={conversationId} />
  </MemoryRouter>
);
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(useViewerId).mockReturnValue("account");
  vi.mocked(useChatActivity).mockReturnValue({
    data: { data: [], coverage: "complete" },
    error: null,
  } as unknown as ReturnType<typeof useChatActivity>);
  vi.mocked(useChildSessions).mockReturnValue({ children: [], isLoading: false, error: null });
  vi.mocked(useActivityConversationState).mockReturnValue(createInitialConversationState());
  vi.mocked(usePeerMessages).mockReturnValue({ messages: [], error: null } as unknown as ReturnType<
    typeof usePeerMessages
  >);
});
afterEach(cleanup);

it("renders no permanent shelf when there is no work, required attention or unread result", () => {
  const { container, rerender } = render(dock());
  expect(container).toBeEmptyDOMElement();
  rerender(dock(null));
  expect(container).toBeEmptyDOMElement();
  expect(useChildSessions).toHaveBeenLastCalledWith(null, { enabled: true, reconcile: true });
});

it("shows a compact conditional summary and bounded expansion without changing execution", () => {
  const state = {
    ...createInitialConversationState(),
    sessionStatus: "running" as const,
    blockedOn: "Permission prompt",
  };
  vi.mocked(useActivityConversationState).mockReturnValue(state);
  vi.mocked(useChildSessions).mockReturnValue({
    children: [
      child({ current_task_status: "in_progress", busy: true, last_message_preview: null }),
    ],
    isLoading: false,
    error: null,
  });
  const { container, rerender } = render(dock());
  const trigger = screen.getByRole("button", { name: "Activity · 2 running · 1 need attention" });
  expect(trigger).toHaveClass("h-8");
  expect(screen.queryByText("Research")).not.toBeInTheDocument();
  fireEvent.click(trigger);
  expect(container.querySelector(".max-h-64.overflow-y-auto")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute("href", "/c/child");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss attention" }));
  expect(screen.getByRole("button", { name: "Activity · 2 running" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(state.sessionStatus).toBe("running");
  expect(state.blockedOn).toBe("Permission prompt");
  rerender(dock());
  expect(screen.getByRole("button", { name: "Activity · 2 running" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

it("marks peer/child results read without deleting history and resurfaces a genuinely new result", () => {
  const children = [child()];
  vi.mocked(useChildSessions).mockReturnValue({ children, isLoading: false, error: null });
  vi.mocked(usePeerMessages).mockReturnValue({
    messages: [peer],
    error: null,
  } as unknown as ReturnType<typeof usePeerMessages>);
  const { container, rerender, unmount } = render(dock());
  fireEvent.click(screen.getByRole("button", { name: "Activity · 2 unread" }));
  expect(screen.getByText("A useful result")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Mark results read" }));
  expect(container).toBeEmptyDOMElement();
  expect(children[0].last_message_preview).toBe("Completed result");
  expect(peer.content).toEqual([{ type: "input_text", text: "A useful result" }]);
  rerender(dock());
  expect(container).toBeEmptyDOMElement();
  unmount();
  const reloaded = render(dock());
  expect(reloaded.container).toBeEmptyDOMElement();
  vi.mocked(useChildSessions).mockReturnValue({
    children: [child({ last_message_preview: "Another completed result" })],
    isLoading: false,
    error: null,
  });
  reloaded.rerender(dock());
  expect(screen.getByRole("button", { name: "Activity · 1 unread" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it("resets expansion and read-state at conversation/account boundaries", () => {
  vi.mocked(usePeerMessages).mockReturnValue({
    messages: [peer],
    error: null,
  } as unknown as ReturnType<typeof usePeerMessages>);
  const { rerender, container } = render(dock());
  fireEvent.click(screen.getByRole("button", { name: "Activity · 1 unread" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark results read" }));
  expect(container).toBeEmptyDOMElement();
  vi.mocked(usePeerMessages).mockReturnValue({
    messages: [
      {
        ...peer,
        communication: { ...peer.communication, destination_conversation_id: "other-chat" },
      },
    ],
    error: null,
  } as unknown as ReturnType<typeof usePeerMessages>);
  rerender(dock("other-chat"));
  expect(screen.getByRole("button", { name: "Activity · 1 unread" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  vi.mocked(useViewerId).mockReturnValue("other-account");
  rerender(dock());
  expect(screen.getByRole("button", { name: "Activity · 1 unread" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it("coalesces shell/command/background evidence and keeps outgoing failure distinct from execution", () => {
  const state = {
    ...createInitialConversationState(),
    backgroundTaskCount: 1,
    backgroundTasks: [{ id: "term", command: "build" }],
  };
  const shell = {
    id: "launch",
    kind: "terminal" as const,
    session_id: "chat",
    terminal_id: "term",
    name: "build",
    state: "running" as const,
    owner_kind: "chat" as const,
    owner_id: "chat",
  };
  const outgoing: PeerActivityMessage = {
    ...peer,
    direction: "outgoing",
    communication: { ...peer.communication, delivery_state: "unknown" },
  };
  const items = conversationActivityItems(
    "chat",
    state,
    [],
    [shell, { ...shell, id: "command", kind: "command" }],
    [outgoing],
  );
  expect(items.filter((item) => item.kind === "shell")).toHaveLength(1);
  expect(items.find((item) => item.kind === "message")).toMatchObject({
    attention: true,
    unread: false,
    running: false,
    status: "Unconfirmed",
  });
  expect(
    conversationActivityItems(
      "chat",
      createInitialConversationState(),
      [],
      [{ ...shell, state: "idle" }],
      [],
    ),
  ).toEqual([]);
});

it("surfaces refresh failures without inventing progress or hiding known running work", () => {
  vi.mocked(useActivityConversationState).mockReturnValue({
    ...createInitialConversationState(),
    sessionStatus: "running",
  });
  vi.mocked(usePeerMessages).mockReturnValue({
    messages: [],
    error: new Error("offline"),
  } as unknown as ReturnType<typeof usePeerMessages>);
  render(dock());
  fireEvent.click(screen.getByRole("button", { name: "Activity · 1 running" }));
  expect(screen.getByRole("status")).toHaveTextContent("Some activity could not be refreshed");
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

it("renders outgoing peer messages using the inspected conversation's scope", () => {
  const outgoing: PeerActivityMessage = {
    ...peer,
    direction: "outgoing",
    communication: {
      ...peer.communication,
      source_conversation_id: "chat",
      destination_conversation_id: "destination",
      delivery_state: "failed",
    },
  };
  vi.mocked(usePeerMessages).mockReturnValue({
    messages: [outgoing],
    error: null,
  } as unknown as ReturnType<typeof usePeerMessages>);
  render(dock());
  fireEvent.click(screen.getByRole("button", { name: "Activity · 1 need attention" }));
  expect(screen.getByTestId("peer-message")).toHaveAttribute("data-direction", "sent");
  expect(screen.getByRole("link", { name: "Open chat beside · Agent" })).toHaveAttribute(
    "href",
    "/c/destination",
  );
  expect(screen.queryByRole("link", { name: "From Reviewer" })).not.toBeInTheDocument();
});
