// Modified for Triune; inherited notices remain applicable.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ElicitationBlock } from "@/lib/blocks";
import type * as ChildSessionsModule from "@/hooks/useChildSessions";
import { useChatStore } from "@/store/chatStore";
import { ComposerAttentionShelf } from "./ComposerAttentionShelf";
import userEvent from "@testing-library/user-event";

vi.mock("@/hooks/useChildSessions", async (original) => ({
  ...(await original<typeof ChildSessionsModule>()),
  useChildSessions: () => ({ children: [], isLoading: false, error: null }),
}));

const initial = useChatStore.getState();
function request(id: string, question = false): ElicitationBlock {
  return {
    type: "elicitation",
    ctx: { agent: null, depth: 0, turn: 0, timestamp: 0, responseId: "turn", itemId: id },
    elicitationId: id,
    message: question ? "Choose coverage" : "Allow this command?",
    phase: "tool_call",
    policyName: "native",
    contentPreview: "",
    requestedSchema: {},
    status: "pending",
    response: null,
    ...(question
      ? {
          askUserQuestion: {
            questions: [
              {
                id: "coverage",
                question: "Which checks?",
                options: [{ label: "Focused", description: "Changed behavior" }],
                multiSelect: false,
              },
            ],
          },
        }
      : {}),
  };
}
beforeEach(() =>
  useChatStore.setState({
    ...initial,
    conversationId: "chat-a",
    blocks: [],
    todos: [],
    backgroundTaskCount: 0,
    backgroundTasks: [],
  }),
);
afterEach(() => {
  cleanup();
  useChatStore.setState(initial);
});
function openShelf() {
  return render(
    <MemoryRouter>
      <ComposerAttentionShelf />
    </MemoryRouter>,
  );
}

it("separates questions and permissions and reuses the existing answer form", async () => {
  useChatStore.setState({ blocks: [request("ask", true), request("permission")] });
  openShelf();
  expect(screen.getByRole("button", { name: "Questions: 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approvals: 1" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Questions: 1" }));
  expect(await screen.findByTestId("ask-user-question-form")).toHaveTextContent("Which checks?");
  expect(screen.getByRole("radio", { name: /Focused/ })).toBeInTheDocument();
  act(() =>
    useChatStore.setState({
      blocks: [
        { ...request("ask", true), status: "responded", response: { action: "accept" } },
        request("permission"),
      ],
    }),
  );
  expect(screen.queryByRole("button", { name: "Questions: 1" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approvals: 1" })).toBeInTheDocument();
});

it("opens the existing plan and closes it when the conversation changes", async () => {
  useChatStore.setState({
    todos: [
      { content: "Trace metadata", status: "completed", activeForm: "" },
      { content: "Bridge steering", status: "in_progress", activeForm: "Bridging steering" },
    ],
  });
  openShelf();
  fireEvent.click(screen.getByRole("button", { name: "Plan: 1 of 2 completed" }));
  expect(await screen.findByText("Bridge steering")).toBeInTheDocument();
  act(() => useChatStore.setState({ conversationId: "chat-b", todos: [] }));
  expect(screen.queryByRole("button", { name: /Plan:/ })).not.toBeInTheDocument();
});

it("places shell counts before plan without a dropdown chevron", () => {
  useChatStore.setState({
    backgroundTaskCount: 2,
    todos: [{ content: "Verify", status: "pending", activeForm: "" }],
  });
  openShelf();
  const shelf = screen.getByTestId("composer-attention-shelf");
  const buttons = [...shelf.querySelectorAll("button")];
  expect(buttons[0]).toHaveTextContent("Shells2");
  expect(buttons[1]).toHaveTextContent("Plan0/1");
  expect(shelf.querySelector(".lucide-chevron-down")).toBeNull();
});

it("does not mount unopened mirrored-child forms or their descendant queries", () => {
  useChatStore.setState({
    blocks: [
      { ...request("ask", true), targetSessionId: "child-chat" },
      { ...request("permission"), targetSessionId: "child-chat" },
    ],
  });
  openShelf();
  expect(screen.getByRole("button", { name: "Questions: 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approvals: 1" })).toBeInTheDocument();
  expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  expect(screen.queryByTestId("ask-user-question-form")).toBeNull();
});

it("mounts each request kind on first opening and clears that retention on a conversation switch", () => {
  useChatStore.setState({ blocks: [request("ask", true), request("permission")] });
  openShelf();
  const popup = (label: string) =>
    document.querySelector(`[data-slot="popover-content"][aria-label="${label}"]`);
  expect(popup("Questions")).toBeNull();
  expect(popup("Approvals")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Questions: 1" }));
  const questions = popup("Questions");
  expect(questions).toBeVisible();
  expect(popup("Approvals")).toBeNull();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(popup("Questions")).toBe(questions);
  expect(questions).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Approvals: 1" }));
  expect(popup("Approvals")).toBeVisible();
  expect(popup("Questions")).toBe(questions);
  act(() => useChatStore.setState({ conversationId: "chat-b" }));
  expect(popup("Questions")).toBeNull();
  expect(popup("Approvals")).toBeNull();
});

it("retains question selections when the shelf popup closes and reopens without trapping focus", async () => {
  const user = userEvent.setup();
  useChatStore.setState({ blocks: [request("ask", true), request("permission")] });
  render(
    <MemoryRouter>
      <ComposerAttentionShelf />
      <textarea aria-label="Composer draft" />
    </MemoryRouter>,
  );
  const trigger = screen.getByRole("button", { name: "Questions: 1" });
  await user.click(trigger);
  await user.click(screen.getByRole("radio", { name: /Focused/ }));
  expect(screen.getByRole("radio", { name: /Focused/ })).toBeChecked();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Questions" })).toBeNull();
  expect(trigger).toHaveFocus();
  const draft = screen.getByRole("textbox", { name: "Composer draft" });
  await user.click(draft);
  await user.type(draft, "keep typed draft");
  expect(draft).toHaveFocus();
  expect(draft).toHaveValue("keep typed draft");
  await user.click(trigger);
  expect(screen.getByRole("radio", { name: /Focused/ })).toBeChecked();
  expect(screen.getAllByText("Question 1 of 1")).toHaveLength(1);
});
