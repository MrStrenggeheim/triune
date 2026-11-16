// Modified for Triune; inherited notices remain applicable.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ElicitationBlock } from "@/lib/blocks";
import type * as ChildSessionsModule from "@/hooks/useChildSessions";
import { useChatStore } from "@/store/chatStore";
import { ComposerAttentionShelf } from "./ComposerAttentionShelf";
import {
  ComposerShelfVisibilityProvider,
  ComposerShelfMenuItems,
  useComposerShelfMenuCloseAutoFocus,
} from "./ComposerShelfVisibility";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkbenchProvider } from "@/workbench/WorkbenchContext";
import userEvent from "@testing-library/user-event";

vi.mock("@/hooks/useRuntimeNotices", () => ({
  useRuntimeNotices: () => ({ notices: [], dismiss: vi.fn() }),
}));

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
  const popup = screen.getByRole("dialog", { name: "Questions" });
  expect(within(popup).getAllByText("Which checks?")).toHaveLength(1);
  expect(popup.querySelector("legend")).toHaveClass("font-semibold");
  expect(
    popup.querySelector(
      ".activity-row, .activity-message-header, svg.lucide-message-circle-question-mark",
    ),
  ).toBeNull();
  expect(within(popup).queryByText("Needs input")).toBeNull();
  expect(within(popup).queryByTestId("ask-user-question-progress")).toBeNull();
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
  expect(screen.queryByText("Question 1 of 1")).toBeNull();
});

it("counts actual batches once and switches their forms without discarding drafts", () => {
  const first = request("first", true);
  const second = request("second", true);
  second.askUserQuestion = {
    questions: [
      {
        id: "other",
        question: "Which other checks?",
        options: [{ label: "Broader" }],
        multiSelect: false,
      },
    ],
  };
  useChatStore.setState({ blocks: [first, first, second] });
  openShelf();
  fireEvent.click(screen.getByRole("button", { name: "Questions: 2" }));
  fireEvent.click(screen.getByRole("radio", { name: /Focused/ }));
  expect(screen.getAllByText("Which checks?")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Question batch 2 of 2" }));
  expect(screen.queryByRole("radio", { name: /Focused/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Broader" }));
  fireEvent.click(screen.getByRole("button", { name: "Question batch 1 of 2" }));
  expect(screen.getByRole("radio", { name: /Focused/ })).toBeChecked();
  expect(screen.queryByRole("radio", { name: "Broader" })).toBeNull();
});

it("uses only the footer to navigate a popup batch and submits its original ids once", () => {
  const submitApproval = vi.fn();
  const block = request("popup-batch", true);
  block.askUserQuestion = {
    questions: [
      {
        id: "coverage",
        header: "Coverage",
        question: "Which checks?",
        options: [{ label: "Focused" }],
        multiSelect: false,
      },
      {
        id: "timing",
        question: "When should checks run?",
        options: [{ label: "Later" }],
        multiSelect: false,
      },
    ],
  };
  useChatStore.setState({ blocks: [block], submitApproval });
  openShelf();
  fireEvent.click(screen.getByRole("button", { name: "Questions: 1" }));
  expect(screen.queryByText("Coverage")).toBeNull();
  expect(screen.queryByRole("button", { name: "Next question" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Skip (0/2)" }));
  expect(screen.queryByText("Coverage")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Later" }));
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  fireEvent.click(screen.getByRole("radio", { name: /Focused/ }));
  fireEvent.click(screen.getByRole("button", { name: "Next (2/2)" }));
  expect(screen.getByRole("radio", { name: "Later" })).toBeChecked();
  expect(submitApproval).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Submit (2/2)" }));
  expect(submitApproval).toHaveBeenCalledExactlyOnceWith("popup-batch", "accept", {
    coverage: "Focused",
    timing: "Later",
  });
});

it("keeps required schema fields and decline semantics in the plain popup", () => {
  const submitApproval = vi.fn();
  const block = request("schema-question");
  block.message = "Which branch?";
  block.requestedSchema = {
    type: "object",
    properties: { branch: { type: "string", title: "Branch" } },
    required: ["branch"],
  };
  useChatStore.setState({ blocks: [block], submitApproval });
  openShelf();
  fireEvent.click(screen.getByRole("button", { name: "Questions: 1" }));
  const popup = screen.getByRole("dialog", { name: "Questions" });
  expect(within(popup).getByText("Which branch?")).toHaveClass("font-semibold");
  expect(popup.querySelector('[role="alert"]')).toBeNull();
  expect(within(popup).getByRole("button", { name: "Submit" })).toBeDisabled();
  fireEvent.change(within(popup).getByLabelText(/Branch/), { target: { value: "main" } });
  expect(within(popup).getByRole("button", { name: "Submit" })).toBeEnabled();
  fireEvent.click(within(popup).getByRole("button", { name: "Reject" }));
  expect(submitApproval).toHaveBeenCalledExactlyOnceWith("schema-question", "decline", undefined);
});

it("shares composer collision bounds with one observer per open shelf popup", () => {
  const observers: {
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, observe: this.observe, disconnect: this.disconnect });
      }
    },
  );
  try {
    useChatStore.setState({ blocks: [request("width", true), request("permission")] });
    const { container } = render(
      <MemoryRouter>
        <div className="composer-shelf-stack" style={{ paddingLeft: 12, paddingRight: 12 }}>
          <ComposerAttentionShelf />
        </div>
      </MemoryRouter>,
    );
    const column = container.querySelector(".composer-shelf-stack")!;
    let columnWidth = 422;
    column.getBoundingClientRect = () =>
      ({
        left: 100,
        right: 100 + columnWidth,
        width: columnWidth,
        top: 600,
        bottom: 640,
        height: 40,
      }) as DOMRect;
    expect(
      observers.filter((observer) => observer.observe.mock.calls.some(([node]) => node === column)),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Questions: 1" }));
    const popup = screen.getByRole("dialog", { name: "Questions" });
    expect(popup.style.maxWidth).toContain("--radix-popper-available-width");
    expect(popup).toHaveAttribute("data-align", "center");
    expect(popup.className).toContain("30rem");
    const widths = observers.filter((observer) =>
      observer.observe.mock.calls.some(([node]) => node === column),
    );
    expect(widths).toHaveLength(1);
    act(() => {
      columnWidth = 300;
      widths[0].callback([], {} as ResizeObserver);
    });
    expect(popup.style.maxWidth).toContain("--radix-popper-available-width");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(widths[0].disconnect).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Approvals: 1" }));
    expect(screen.getByRole("dialog", { name: "Approvals" }).className).toContain("25rem");
    expect(screen.getByRole("dialog", { name: "Approvals" }).style.maxWidth).toContain(
      "--radix-popper-available-width",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

function ShelfActivityMenu({ modal }: { modal: boolean }) {
  const onCloseAutoFocus = useComposerShelfMenuCloseAutoFocus();
  return (
    <DropdownMenu modal={modal}>
      <DropdownMenuTrigger>Activity menu</DropdownMenuTrigger>
      <DropdownMenuContent onCloseAutoFocus={onCloseAutoFocus}>
        <ComposerShelfMenuItems conversationId="conv" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function mountShelfWithMenu(openView = vi.fn(), modal = true) {
  return render(
    <MemoryRouter>
      <WorkbenchProvider value={{ openConversation: vi.fn(), openView }}>
        <ComposerShelfVisibilityProvider>
          <ComposerAttentionShelf />
          <ShelfActivityMenu modal={modal} />
        </ComposerShelfVisibilityProvider>
      </WorkbenchProvider>
    </MemoryRouter>,
  );
}
const openActivityMenu = () =>
  fireEvent.pointerDown(screen.getByRole("button", { name: "Activity menu" }), {
    button: 0,
    ctrlKey: false,
  });

it.each([true, false])("reopens a settled plan after its menu closes (modal %s)", (modal) => {
  vi.useFakeTimers();
  try {
    useChatStore.setState({
      todos: [{ content: "Finished step", status: "completed", activeForm: "" }],
    });
    const openView = vi.fn();
    const { container } = mountShelfWithMenu(openView, modal);
    expect(container.querySelector(".composer-shelf-presence")).toHaveAttribute("hidden");
    expect(screen.queryByRole("button", { name: /Plan:/ })).toBeNull();
    openActivityMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open plan" }));
    act(() => vi.advanceTimersByTime(20));
    expect(screen.getByRole("dialog", { name: "Plan" })).toHaveTextContent("Finished step");
    fireEvent.keyDown(document.body, { key: "Escape" });
    openActivityMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide activity shelf" }));
    act(() => vi.advanceTimersByTime(200));
    expect(container.querySelector(".composer-shelf-presence")).toHaveAttribute("hidden");
    openActivityMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open activity resources" }));
    expect(openView).toHaveBeenCalledWith(
      {
        kind: "activity",
        conversationId: "conv",
        source: { kind: "chat", conversationId: "conv" },
        title: "Orchestration",
      },
      { beside: true },
    );
  } finally {
    vi.useRealTimers();
  }
});

it("preserves pending answers across manual hiding and re-reveals new questions or approvals", () => {
  vi.useFakeTimers();
  try {
    useChatStore.setState({ blocks: [request("first", true)] });
    mountShelfWithMenu();
    act(() => vi.advanceTimersByTime(20));
    fireEvent.click(screen.getByRole("button", { name: "Questions: 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Custom answer text" }), {
      target: { value: "Keep this answer" },
    });
    openActivityMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide activity shelf" }));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("button", { name: "Questions: 1" })).toBeNull();
    openActivityMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show activity shelf" }));
    act(() => vi.advanceTimersByTime(20));
    fireEvent.click(screen.getByRole("button", { name: "Questions: 1" }));
    expect(screen.getByRole("textbox", { name: "Custom answer text" })).toHaveValue(
      "Keep this answer",
    );
    openActivityMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide activity shelf" }));
    act(() => vi.advanceTimersByTime(200));
    act(() => useChatStore.setState({ blocks: [request("first", true), request("new-approval")] }));
    expect(screen.getByRole("button", { name: "Approvals: 1" })).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});
