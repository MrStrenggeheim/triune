// Modified for Triune.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bubble } from "@/lib/renderItems";
import { useChatStore, type ChatState } from "@/store/chatStore";
import { conversationRegistry } from "@/store/conversationRegistry";
import { ForkDialogContextProvider } from "@/shell/ForkDialogContext";
import { BubbleView, buildPendingBubbles, containsMermaidDiagram } from "./chatBubbleParts";
import { MemoryRouter } from "react-router-dom";
import type { MessageCommunication } from "@/lib/messageCommunication";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import { buildBubbles } from "@/lib/renderItems";
import type { MessageItem } from "@/lib/conversationItems";
import { TooltipProvider } from "@/components/ui/tooltip";

const fetchMock = vi.fn();
const initialStoreState = useChatStore.getState();
const continuation = "Please continue from where you left off.";

describe("input attribution", () => {
  function renderInput(item: MessageItem) {
    const [bubble] = buildBubbles(itemsToBlocks([item]), null);
    if (!bubble) throw new Error("Missing input bubble");
    return render(
      <MemoryRouter>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <TooltipProvider>
            <ConversationScopeContext.Provider value="recipient">
              <BubbleView bubble={bubble} />
            </ConversationScopeContext.Provider>
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  const input: MessageItem = {
    id: "input-id",
    response_id: "response",
    type: "message",
    status: "completed",
    role: "user",
    created_by: "account@example.com",
    content: [{ type: "input_text", text: continuation }],
  };
  const system: MessageCommunication = {
    kind: "system",
    message_id: input.id,
    destination_conversation_id: "recipient",
    source_title: "Recovery",
    delivery_state: "confirmed",
  };

  it.each([
    "[System: timer build fired]",
    "[Request interrupted by user for tool use]",
    continuation,
    '<agent-message from="reviewer">Ready</agent-message>',
    "This session is being continued from a previous conversation that ran out of context.",
  ])("keeps an exact human quotation human: %s", (text) => {
    renderInput({ ...input, user_authored: true, content: [{ type: "input_text", text }] });
    expect(screen.getByTestId("message-bubble")).toHaveAttribute("data-role", "user");
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByTestId("system-message")).not.toBeInTheDocument();
  });

  it("shows unknown input as External even with an authenticated account and system-shaped text", () => {
    const text = "[System: interrupted]";
    renderInput({ ...input, content: [{ type: "input_text", text }] });
    expect(screen.getByTestId("message-bubble")).toHaveAttribute("data-role", "external");
    expect(screen.getByText("External input")).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByTestId("message-author")).not.toBeInTheDocument();
    expect(screen.queryByTestId("system-message")).not.toBeInTheDocument();
  });

  it("formats typed recovery as System and retains complete Copy and source links", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderInput({
      ...input,
      user_authored: true,
      communication: { ...system, source_conversation_id: "source" },
    });
    expect(screen.getByTestId("system-message")).toHaveTextContent("System: Recovery");
    fireEvent.click(screen.getByRole("button", { name: /System: Recovery/ }));
    expect(screen.getByText(continuation)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Recovery" })).toHaveAttribute("href", "/c/source");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(continuation));
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("message=input-id")),
    );
    expect(screen.queryByTestId("message-author")).not.toBeInTheDocument();
  });

  it.each([undefined, "external", "system"] as const)(
    "preserves files, images and mentions for %s input",
    (kind) => {
      fetchMock.mockResolvedValue(
        jsonResponse({ name: "notes.txt", metadata: { bytes: 12, content_type: "text/plain" } }),
      );
      renderInput({
        ...input,
        ...(kind ? { communication: { ...system, kind } } : {}),
        content: [
          { type: "input_text", text: `${continuation}\n[Attached: src/main.ts]` },
          { type: "input_file", file_id: "file", filename: "notes.txt" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,aGVsbG8=",
            filename: "shot.png",
          },
        ],
      });
      expect(screen.getByTestId("message-bubble")).toHaveAttribute(
        "data-role",
        kind === "system" ? "system" : "external",
      );
      expect(screen.getByText(continuation)).toBeInTheDocument();
      expect(screen.getByTestId("chat-attachment")).toHaveTextContent("notes.txt");
      expect(screen.getByRole("img", { name: "shot.png" })).toBeInTheDocument();
      expect(screen.getByText("@src/main.ts")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
    },
  );

  it("keeps text-only System file mentions visible", () => {
    renderInput({
      ...input,
      communication: system,
      content: [{ type: "input_text", text: "[Attached: src/main.ts]" }],
    });
    expect(screen.getByText("@src/main.ts")).toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorBubble(code = "rate_limit_exceeded"): Extract<Bubble, { kind: "assistant" }> {
  return {
    kind: "assistant",
    responseId: "resp_failed",
    stableId: "error_failed",
    lifecycle: "failed",
    error: null,
    items: [
      {
        kind: "error",
        itemId: "error_failed",
        message: "API Error: Request rejected (429): workspace input tokens per minute rate limit",
        source: "execution",
        code,
      },
    ],
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useChatStore.setState({
    conversationId: "conv_retry",
    sessionStatus: "failed",
    status: "idle",
    activeResponse: null,
    blocks: [],
    pendingUserMessages: [],
    failedSendDraft: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useChatStore.setState(initialStoreState);
});

it("places explicit user attachments after the message text", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse({ name: "notes.txt", metadata: { bytes: 12, content_type: "text/plain" } }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <BubbleView
          bubble={{
            kind: "user",
            userAuthored: true,
            itemId: "user_file",
            content: [
              { type: "input_file", file_id: "original-file", filename: "notes.txt" },
              { type: "input_text", text: "Review these notes." },
            ],
          }}
          isLastAssistant={false}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const text = screen.getByText("Review these notes.");
  const attachment = screen.getByTestId("chat-attachment");
  expect(text.compareDocumentPosition(attachment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await waitFor(() => expect(attachment).toHaveTextContent("text/plain"));
  expect(attachment).toHaveTextContent("12 B");
  expect(screen.getByRole("button", { name: "Download notes.txt" })).toBeEnabled();
});

it("keeps scoped assistant bubbles unchanged for unrelated text and primary updates", () => {
  const first = conversationRegistry.acquire("first");
  const second = conversationRegistry.acquire("second");
  const commits = { first: vi.fn(), second: vi.fn() };
  const bubble = errorBubble();
  try {
    render(
      <>
        {(["first", "second"] as const).map((id) => (
          <ConversationScopeContext.Provider key={id} value={id}>
            <Profiler id={id} onRender={commits[id]}>
              <BubbleView bubble={bubble} isLastAssistant />
            </Profiler>
          </ConversationScopeContext.Provider>
        ))}
      </>,
    );
    const initial = {
      first: commits.first.mock.calls.length,
      second: commits.second.mock.calls.length,
    };
    const text = {
      type: "text_done" as const,
      ctx: { agent: null, depth: 0, turn: 0, timestamp: 0, responseId: "another", itemId: "text" },
      fullText: "another bubble's text",
      hasCodeBlocks: false,
    };
    act(() => first.setState({ blocks: [text], tokensUsed: 20 }));
    act(() => second.setState({ blocks: [{ ...text, fullText: "second conversation" }] }));
    act(() => useChatStore.setState({ conversationId: "third", sessionStatus: "running" }));
    expect(commits.first).toHaveBeenCalledTimes(initial.first);
    expect(commits.second).toHaveBeenCalledTimes(initial.second);

    act(() => first.setState({ sessionStatus: "waiting" }));
    expect(commits.first.mock.calls.length).toBeGreaterThan(initial.first);
    expect(commits.second).toHaveBeenCalledTimes(initial.second);
  } finally {
    cleanup();
    conversationRegistry.clear();
  }
});

describe("Mermaid diagram width", () => {
  it("uses the full chat column for a Mermaid fence", () => {
    const items = [
      { kind: "text" as const, itemId: "diagram", text: "```mermaid\nA-->B\n```", final: true },
    ];
    expect(containsMermaidDiagram(items)).toBe(true);
    const bubble: Extract<Bubble, { kind: "assistant" }> = {
      kind: "assistant",
      responseId: "resp_diagram",
      stableId: "diagram",
      lifecycle: "completed",
      error: null,
      items,
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BubbleView bubble={bubble} isLastAssistant={false} />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("message-bubble")).toHaveClass("max-w-full");
    expect(screen.getByTestId("message-bubble").firstElementChild).toHaveClass("w-full");
  });

  it("ignores Mermaid mentioned outside a fence", () => {
    expect(
      containsMermaidDiagram([
        { kind: "text", itemId: "prose", text: "A Mermaid diagram would help.", final: true },
      ]),
    ).toBe(false);
  });
});

describe("AssistantBubble fork source", () => {
  const bubble: Extract<Bubble, { kind: "assistant" }> = {
    kind: "assistant",
    responseId: "resp_side_reply",
    stableId: "side_reply",
    lifecycle: "completed",
    error: null,
    items: [{ kind: "text", itemId: "side_text", text: "Side reply", final: true }],
  };

  it("disables the message fork without hiding its explanation", () => {
    const openForkDialog = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ForkDialogContextProvider
          value={{
            canFork: true,
            disabledReason: "Forking this sandbox session is not supported yet.",
            openForkDialog,
          }}
        >
          <BubbleView bubble={bubble} isLastAssistant={false} />
        </ForkDialogContextProvider>
      </QueryClientProvider>,
    );
    const fork = screen.getByTestId("fork-from-response");
    expect(fork).toBeDisabled();
    expect(fork.parentElement).toHaveAttribute("tabindex", "0");
    fireEvent.click(fork);
    fireEvent.keyDown(fork.parentElement!, { key: "Enter" });
    expect(openForkDialog).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "side chat",
      scope: "conv_side_child",
      expected: {
        sourceSessionId: "conv_side_child",
        upToResponseId: "resp_side_reply",
      },
    },
    {
      name: "main chat",
      scope: null,
      expected: { sourceSessionId: undefined, upToResponseId: "resp_side_reply" },
    },
  ])("opens from the $name session", ({ scope, expected }) => {
    const openForkDialog = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ForkDialogContextProvider value={{ canFork: true, openForkDialog }}>
          <ConversationScopeContext.Provider value={scope}>
            <BubbleView bubble={bubble} isLastAssistant={false} />
          </ConversationScopeContext.Provider>
        </ForkDialogContextProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("fork-from-response"));

    expect(openForkDialog).toHaveBeenCalledOnce();
    expect(openForkDialog).toHaveBeenCalledWith(expected);
  });
});

describe("message navigation highlight", () => {
  const text = "Highlight only this message content";
  const messageId = "highlight_target";
  const createdAtS = 1_700_000_000;
  const bubbles: Bubble[] = [
    {
      kind: "user",
      userAuthored: true,
      itemId: messageId,
      content: [{ type: "input_text", text }],
      createdAtS,
    },
    {
      kind: "assistant",
      responseId: messageId,
      stableId: "highlight_assistant",
      lifecycle: "completed",
      error: null,
      items: [{ kind: "text", itemId: "highlight_text", text, final: true }],
      createdAtS,
    },
  ];

  it.each(bubbles)("keeps the $kind highlight inside the content bubble", (bubble) => {
    useChatStore.setState({ flashItemId: null });
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <BubbleView bubble={bubble} isLastAssistant={false} />
      </QueryClientProvider>,
    );
    const highlightSelector = ".animate-message-highlight";
    expect(container.querySelector(highlightSelector)).toBeNull();

    act(() => useChatStore.setState({ flashItemId: messageId }));

    const highlight = screen.getByText(text).closest(highlightSelector);
    expect(highlight).not.toBeNull();
    expect(container.querySelectorAll(highlightSelector)).toHaveLength(1);
    expect(screen.getByTestId("message-bubble")).not.toHaveClass("animate-message-highlight");
    expect(screen.getByTestId("message-timestamp").closest(highlightSelector)).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect(button.closest(highlightSelector)).toBeNull();
    }

    act(() => useChatStore.setState({ flashItemId: "another_message" }));
    expect(container.querySelector(highlightSelector)).toBeNull();

    act(() => useChatStore.setState({ flashItemId: messageId }));
    expect(screen.getByText(text).closest(highlightSelector)).not.toBeNull();
    act(() => useChatStore.setState({ flashItemId: null }));
    expect(container.querySelector(highlightSelector)).toBeNull();
  });
});

describe("UserBubble literal text", () => {
  it.each(["", "[Attached: docs/a.md]\n\n", "[Attached file: docs/a.md]\r\n\r\n"])(
    "keeps indented bullets as siblings after stripping %j",
    (preamble) => {
      render(
        <BubbleView
          bubble={{
            kind: "user",
            userAuthored: true,
            itemId: "user_list",
            content: [{ type: "input_text", text: `${preamble}  - first\n  - second` }],
          }}
          isLastAssistant={false}
        />,
      );

      expect(screen.getAllByRole("list")).toHaveLength(1);
      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(items[0].parentElement).toBe(items[1].parentElement);
    },
  );

  it.each([
    [
      "unfinished placeholder",
      "how about to reduce the output you can do like\n• ••\n" +
        "<exact line(s) that needs to be seen without edit\n" +
        "so for any matching line in the output which shows it, dont edit it or excerpt it, " +
        "if any of the line shows important info",
    ],
    ["complete placeholder", "Keep <exact lines> visible."],
    ["HTML example", '<div class="example">Keep this text</div>'],
    ["HTML comment", "Keep <!-- this comment --> visible."],
    ["multiline HTML", "<div>\n  first line\n  second line\n</div>"],
  ])("preserves %s", (_name, text) => {
    render(
      <BubbleView
        bubble={{
          kind: "user",
          userAuthored: true,
          itemId: "user_literal",
          content: [{ type: "input_text", text }],
        }}
        isLastAssistant={false}
      />,
    );

    const bubble = screen.getByTestId("message-bubble");
    for (const line of text.split("\n")) {
      expect(bubble).toHaveTextContent(line.trim());
    }
  });

  it("keeps Markdown formatting and inline code alongside literal tags", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BubbleView
          bubble={{
            kind: "user",
            userAuthored: true,
            itemId: "user_markdown",
            content: [
              {
                type: "input_text",
                text: "**Keep** <exact lines> and `<code>`\n\n- first\n- second",
              },
            ],
          }}
          isLastAssistant={false}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Keep")).toHaveAttribute("data-streamdown", "strong");
    expect(screen.getByText("<code>").tagName).toBe("CODE");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByTestId("message-bubble")).toHaveTextContent("<exact lines>");
  });
});

describe("AssistantBubble error retry", () => {
  it("submits one continuation for a rate limit without replaying the original input", async () => {
    let finishRetry: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishRetry = resolve;
        }),
    );
    const draft = { conversationId: "conv_retry", text: "My unsent draft", files: [] };
    useChatStore.setState({ failedSendDraft: draft });
    render(<BubbleView bubble={errorBubble()} isLastAssistant />);

    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/sessions/conv_retry/events");
    expect(JSON.parse(init.body as string)).toEqual({
      type: "message",
      data: { role: "user", content: [{ type: "input_text", text: continuation }] },
    });
    expect(useChatStore.getState().failedSendDraft).toBe(draft);

    await act(async () => {
      finishRetry?.(jsonResponse({ queued: true, pending_id: "pending_retry" }));
    });

    expect(screen.queryByTestId("error-pill")).toBeNull();
    expect(useChatStore.getState().failedSendDraft).toBe(draft);
  });

  it("continues a transient upstream failure in place instead of resuming the runner", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ queued: true, pending_id: "pending_retry" }));
    render(<BubbleView bubble={errorBubble("transient_upstream_error")} isLastAssistant />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/sessions/conv_retry/events");
    expect(JSON.parse(init.body as string)).toEqual({
      type: "message",
      data: { role: "user", content: [{ type: "input_text", text: continuation }] },
    });
  });

  it("continues a dropped harness stream in place instead of resuming the runner", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ queued: true, pending_id: "pending_retry" }));
    render(<BubbleView bubble={errorBubble("connection_error")} isLastAssistant />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/sessions/conv_retry/events");
    expect(JSON.parse(init.body as string)).toEqual({
      type: "message",
      data: { role: "user", content: [{ type: "input_text", text: continuation }] },
    });
  });

  it("coalesces retry clicks from separate rate-limit cards in the same turn", async () => {
    let finishRetry: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishRetry = resolve;
        }),
    );
    const bubble = errorBubble();
    bubble.items.push({
      kind: "error",
      itemId: "error_second",
      code: "rate_limit_exceeded",
      source: "execution",
      message: "Too many requests: request rate limit exceeded",
    });
    render(<BubbleView bubble={bubble} isLastAssistant />);

    const retryButtons = screen.getAllByRole("button", { name: "Retry" });
    expect(retryButtons).toHaveLength(2);
    fireEvent.click(retryButtons[0]!);
    fireEvent.click(retryButtons[1]!);

    expect(fetchMock).toHaveBeenCalledOnce();

    await act(async () => {
      finishRetry?.(jsonResponse({ queued: true, pending_id: "pending_retry" }));
    });

    expect(screen.queryAllByTestId("error-pill")).toHaveLength(0);
  });

  it.each([
    {
      response: () =>
        jsonResponse({ error: { code: "runner_unavailable", message: "Host is offline" } }, 503),
      message: "Host is offline",
    },
    {
      response: () => jsonResponse({ queued: false, denied: true }),
      message: "The retry was blocked by a policy",
    },
  ])("preserves the card and composer draft when retry fails: $message", async (testCase) => {
    fetchMock.mockResolvedValueOnce(testCase.response());
    const draft = { conversationId: "conv_retry", text: "Keep this draft", files: [] };
    useChatStore.setState({ failedSendDraft: draft });
    render(<BubbleView bubble={errorBubble()} isLastAssistant />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(`Retry failed: ${testCase.message}`),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(useChatStore.getState().failedSendDraft).toBe(draft);
  });

  it.each<Partial<ChatState>>([
    { sessionStatus: "launching" },
    { sessionStatus: "running" },
    { sessionStatus: "waiting" },
    { status: "streaming" },
    {
      pendingUserMessages: [
        {
          tempId: "pending_user",
          content: [{ type: "input_text", text: "A new request" }],
          createdAtS: 1,
        },
      ],
    },
  ])("does not queue a continuation while the session is busy: %o", async (state) => {
    useChatStore.setState(state);
    render(<BubbleView bubble={errorBubble()} isLastAssistant />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Wait for the current turn to finish before retrying",
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not continue an old failed turn after a newer assistant response", async () => {
    render(<BubbleView bubble={errorBubble()} isLastAssistant={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Only the latest failed turn can be retried",
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send a stale click to a newly selected session", async () => {
    render(<BubbleView bubble={errorBubble()} isLastAssistant />);
    const current = useChatStore.getState();
    vi.spyOn(useChatStore, "getState").mockReturnValue({
      ...current,
      conversationId: "conv_other",
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("The selected session has changed"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps infrastructure-error retry on the runner recovery path", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ queued: false, recovered: true, recovery: "native_terminal_ready" }),
    );
    render(<BubbleView bubble={errorBubble("required_terminal_exited")} />);

    fireEvent.click(screen.getByRole("button", { name: "Resume session" }));

    await waitFor(() => expect(screen.queryByTestId("error-pill")).toBeNull());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/sessions/conv_retry/events");
    expect(JSON.parse(init.body as string)).toEqual({ type: "retry_session", data: {} });
  });
});

describe("AssistantBubble error-only role", () => {
  // The reconnect journey counts [data-role="assistant"] bubbles as Claude
  // replies. An undelivered-message notice is a standalone error item with no
  // prose, so it must not carry the assistant role and inflate that count.
  it("tags an undelivered-message notice as an error bubble, not an assistant reply", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BubbleView
          bubble={{
            kind: "assistant",
            responseId: "resp_undelivered",
            stableId: "undelivered_notice",
            lifecycle: "failed",
            error: null,
            items: [
              {
                kind: "error",
                itemId: "undelivered_notice",
                message: "Message not delivered. Try sending it again.",
                source: "runtime",
                code: "native_prompt_not_recorded",
              },
            ],
          }}
          isLastAssistant={false}
        />
      </QueryClientProvider>,
    );

    const bubble = screen.getByTestId("message-bubble");
    expect(bubble).toHaveAttribute("data-role", "error");
    expect(bubble).toHaveTextContent("Message not delivered. Try sending it again.");
  });

  it.each<{ name: string; nonError: Extract<Bubble, { kind: "assistant" }>["items"][number] }>([
    {
      name: "a prose reply carrying a trailing error",
      nonError: { kind: "text", itemId: "reply_text", text: "the answer is 42", final: true },
    },
    {
      name: "a failed turn with reasoning but no prose",
      nonError: {
        kind: "reasoning",
        itemId: "thinking",
        text: "Weighing the options.",
        duration: 1,
      },
    },
  ])("keeps $name on the assistant role", ({ nonError }) => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BubbleView
          bubble={{
            kind: "assistant",
            responseId: "resp_mixed_failure",
            stableId: "mixed_failure",
            lifecycle: "failed",
            error: null,
            items: [
              nonError,
              {
                kind: "error",
                itemId: "mixed_error",
                message: "API Error: Request rejected (429): rate limit",
                source: "execution",
                code: "rate_limit_exceeded",
              },
            ],
          }}
          isLastAssistant={false}
        />
      </QueryClientProvider>,
    );

    const bubble = screen.getByTestId("message-bubble");
    expect(bubble).toHaveAttribute("data-role", "assistant");
  });
});

describe("AssistantBubble sealed side-chat recovery", () => {
  it("removes recovery actions when the side chat is sealed but keeps the error", () => {
    const view = render(
      <BubbleView bubble={errorBubble("required_terminal_exited")} recoveryDisabled />,
    );

    expect(screen.queryByRole("button", { name: "Resume session" })).toBeNull();
    expect(screen.getByTestId("error-pill")).toHaveTextContent("The agent's terminal exited");

    view.rerender(<BubbleView bubble={errorBubble("required_terminal_exited")} />);

    expect(screen.getByRole("button", { name: "Resume session" })).toBeInTheDocument();
  });

  it.each([null, "conv_child"])(
    "refreshes the resumed session's labels (scope=%s)",
    async (scope) => {
      const client = new QueryClient();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: { code: "conflict", message: "This side chat has ended." } }, 409),
      );
      render(
        <QueryClientProvider client={client}>
          <ConversationScopeContext.Provider value={scope}>
            <BubbleView bubble={errorBubble("required_terminal_exited")} />
          </ConversationScopeContext.Provider>
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Resume session" }));

      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", scope ?? "conv_retry"] }),
      );
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`/v1/sessions/${scope ?? "conv_retry"}/events`);
      expect(screen.getByRole("status")).toHaveTextContent("This side chat has ended.");
    },
  );

  it("preserves the error when rendered without a query provider", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "conflict", message: "This side chat has ended." } }, 409),
    );
    render(<BubbleView bubble={errorBubble("required_terminal_exited")} />);

    fireEvent.click(screen.getByRole("button", { name: "Resume session" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("This side chat has ended."),
    );
  });
});

describe("UserBubble shell prompts", () => {
  it("preserves shell syntax and attachment-like text literally", () => {
    const command = "printf '%s\\n' '**hi**' '[Attached: /tmp/file]' '`pwd`'\necho done";
    const bubble: Extract<Bubble, { kind: "user" }> = {
      kind: "user",
      userAuthored: true,
      itemId: "shell-input",
      content: [{ type: "input_text", text: `!${command}` }],
      shellCommand: command,
    };
    render(<BubbleView bubble={bubble} />);

    const prompt = screen.getByTestId("message-bubble");
    expect(prompt).toHaveAttribute("data-role", "user");
    expect(prompt).toHaveAttribute("data-user-message-id", "shell-input");
    expect(prompt.querySelector("pre")?.textContent).toBe(`!${command}`);
    expect(screen.getByTestId("copy-message-link")).toBeEnabled();
  });
});

describe("UserBubble long-prompt collapse", () => {
  const COLLAPSE_THRESHOLD = 12000;
  const TAIL = "UNIQUE_TAIL";

  // Overflowing ASCII characters followed by the tail
  const LONG_TEXT = "a".repeat(COLLAPSE_THRESHOLD) + TAIL;
  const EMOJI_AT_BOUNDARY = "a".repeat(COLLAPSE_THRESHOLD - 1) + "🔥" + "b".repeat(100);
  const SHORT_TEXT = "Hello, world!";

  function userBubble(text: string): Extract<Bubble, { kind: "user" }> {
    return {
      kind: "user",
      userAuthored: true,
      itemId: "user_collapse_test",
      content: [{ type: "input_text", text }],
    };
  }

  it("renders a short prompt fully without a collapse button", () => {
    render(<BubbleView bubble={userBubble(SHORT_TEXT)} isLastAssistant={false} />);

    expect(screen.getByTestId("message-bubble")).toHaveTextContent(SHORT_TEXT);
    expect(screen.queryByRole("button", { name: /show full prompt/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /collapse prompt/i })).toBeNull();
  });

  it("hides the tail when collapsed, shows it when expanded, hides it again when re-collapsed", () => {
    render(<BubbleView bubble={userBubble(LONG_TEXT)} isLastAssistant={false} />);

    const bubble = screen.getByTestId("message-bubble");

    // Initially collapsed
    expect(bubble).not.toHaveTextContent(TAIL);
    expect(screen.getByRole("button", { name: /show full prompt/i })).toBeInTheDocument();

    // After expanding
    fireEvent.click(screen.getByRole("button", { name: /show full prompt/i }));
    expect(bubble).toHaveTextContent(TAIL);

    // After collapsing again
    fireEvent.click(screen.getByRole("button", { name: /collapse prompt/i }));
    expect(bubble).not.toHaveTextContent(TAIL);
  });

  it("Copy always writes the full text to the clipboard regardless of collapse state", async () => {
    const writtenTexts: string[] = [];
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn((text: string) => {
          writtenTexts.push(text);
          return Promise.resolve();
        }),
      },
    });

    render(<BubbleView bubble={userBubble(LONG_TEXT)} isLastAssistant={false} />);

    const copyButton = screen.getByRole("button", { name: /^copy$/i });
    fireEvent.click(copyButton);

    await waitFor(() => expect(writtenTexts).toHaveLength(1));
    expect(writtenTexts[0]).toBe(LONG_TEXT);
    expect(writtenTexts[0]).toContain(TAIL);
  });

  it("does not corrupt an emoji at slice boundary", () => {
    render(<BubbleView bubble={userBubble(EMOJI_AT_BOUNDARY)} isLastAssistant={false} />);

    const bubble = screen.getByTestId("message-bubble");

    expect(screen.getByRole("button", { name: /show full prompt/i })).toBeInTheDocument();

    expect(bubble).not.toHaveTextContent("🔥");
    expect(bubble).not.toHaveTextContent(""); // make sure it's not corrupted
    expect(bubble).toHaveTextContent("a".repeat(COLLAPSE_THRESHOLD - 1));
  });
});

describe("AssistantBubble copy", () => {
  const MARKDOWN = "## Findings\n\nA **bold** claim and `code`.";

  function assistantBubble(text: string): Extract<Bubble, { kind: "assistant" }> {
    return {
      kind: "assistant",
      responseId: "resp_copy",
      stableId: "copy_assistant",
      lifecycle: "completed",
      error: null,
      items: [{ kind: "text", itemId: "copy_text", text, final: true }],
      createdAtS: 1_700_000_000,
    };
  }

  it("offers rendered HTML alongside the markdown so a rich-text paste keeps formatting", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    class FakeClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }

    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write } });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <BubbleView bubble={assistantBubble(MARKDOWN)} isLastAssistant={false} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));

    const [item] = write.mock.calls[0][0] as FakeClipboardItem[];
    expect(await item.items["text/plain"].text()).toBe(MARKDOWN);
    expect(await item.items["text/html"].text()).toBe(
      "<h2>Findings</h2>\n<p>A <strong>bold</strong> claim and <code>code</code>.</p>",
    );
  });
});

it("renders a restored pending peer with attribution instead of a human bubble", () => {
  const communication: MessageCommunication = {
    kind: "peer",
    message_id: "peer-id",
    source_conversation_id: "source",
    source_title: "Reviewer",
    destination_conversation_id: "recipient",
    delivery_state: "unknown",
    receipt: "accepted",
  };
  const [bubble] = buildPendingBubbles(
    [
      {
        tempId: "pending-peer",
        communication,
        content: [{ type: "input_text", text: "Review result" }],
      },
    ],
    "human-account",
  );
  expect(bubble).toMatchObject({ communication, pending: true });
  render(
    <MemoryRouter>
      <ConversationScopeContext.Provider value="recipient">
        <BubbleView bubble={bubble!} isLastAssistant={false} />
      </ConversationScopeContext.Provider>
    </MemoryRouter>,
  );
  expect(screen.getByText("Agent", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Reviewer" })).toHaveAttribute("href", "/c/source");
  expect(screen.queryByText(/Unconfirmed|accepted/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
  expect(screen.queryByText("human-account")).not.toBeInTheDocument();
});
