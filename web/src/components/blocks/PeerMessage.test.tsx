// Modified for Triune.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getSessionSlim } from "@/lib/sessionsApi";
import type * as SessionsApi from "@/lib/sessionsApi";

vi.mock("@/hooks/useViewerId", () => ({ useViewerId: () => "local" }));
vi.mock("@/lib/sessionsApi", async (original) => ({
  ...(await original<typeof SessionsApi>()),
  getSessionSlim: vi.fn(),
}));
import { MemoryRouter } from "react-router-dom";
import { PeerMessage } from "./PeerMessage";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import { buildBubbles } from "@/lib/renderItems";
import { BlockStream } from "@/lib/blockStream";
import { parseEvent } from "@/lib/sse";
import { readMessageCommunication, type MessageCommunication } from "@/lib/messageCommunication";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { ScopedChatStoreProvider } from "@/workbench/ScopedChatStore";
import { conversationRegistry } from "@/store/conversationRegistry";

const clients: QueryClient[] = [];
function queryClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return client;
}
beforeEach(() => {
  vi.mocked(getSessionSlim).mockReset();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  conversationRegistry.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const communication: MessageCommunication = {
  kind: "peer",
  message_id: "peer-1",
  source_conversation_id: "review",
  destination_conversation_id: "implementation",
  source_title: "Independent review",
  delivery_state: "queued",
  receipt: "accepted",
};

describe("trusted peer presentation", () => {
  it("labels the sender copy as sent to the authorized destination", async () => {
    vi.mocked(getSessionSlim).mockImplementation(
      async (id) =>
        ({
          title: id === "review" ? "Independent review" : "Implementation chat",
          agentName: "Codex",
        }) as Awaited<ReturnType<typeof getSessionSlim>>,
    );
    render(
      <QueryClientProvider client={queryClient()}>
        <MemoryRouter>
          <ConversationScopeContext.Provider value="review">
            <PeerMessage communication={communication} itemId="sent" content={[]} />
          </ConversationScopeContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("link", { name: "Implementation chat" })).toHaveAttribute(
      "href",
      "/c/implementation",
    );
    expect(screen.getByText("sent to")).toBeInTheDocument();
    expect(screen.queryByText("from")).not.toBeInTheDocument();
    expect(screen.getByTestId("peer-message")).toHaveAttribute("data-direction", "sent");
    expect(document.querySelector(".lucide-send")).not.toBeNull();
  });

  it("keeps a forbidden destination title out of the sender copy", async () => {
    vi.mocked(getSessionSlim).mockImplementation(async (id) => {
      if (id === "implementation") throw new Error("Forbidden");
      return { title: "Own chat", agentName: "Codex" } as Awaited<
        ReturnType<typeof getSessionSlim>
      >;
    });
    render(
      <QueryClientProvider client={queryClient()}>
        <MemoryRouter>
          <ConversationScopeContext.Provider value="review">
            <PeerMessage communication={communication} itemId="sent" content={[]} />
          </ConversationScopeContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("Codex", { selector: "strong" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "conversation" })).toHaveAttribute(
      "href",
      "/c/implementation",
    );
    expect(screen.queryByRole("link", { name: "Own chat" })).not.toBeInTheDocument();
  });

  it("removes a cached source title when access is revoked", async () => {
    const client = queryClient();
    vi.mocked(getSessionSlim).mockResolvedValue({
      title: "Private reviewer",
      subAgentName: "James",
      agentName: "Codex",
    } as Awaited<ReturnType<typeof getSessionSlim>>);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <PeerMessage communication={communication} itemId="item" content={[]} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Private reviewer" })).toHaveTextContent(
        "Private reviewer",
      ),
    );
    let completeRefresh!: (value: Awaited<ReturnType<typeof getSessionSlim>>) => void;
    vi.mocked(getSessionSlim).mockReturnValueOnce(
      new Promise((resolve) => {
        completeRefresh = resolve;
      }),
    );
    let refresh!: Promise<void>;
    act(() => {
      refresh = client.invalidateQueries({ queryKey: ["peer-source-label"] });
    });
    expect(screen.getByRole("link", { name: "Private reviewer" })).toHaveTextContent(
      "Private reviewer",
    );
    expect(screen.getByText("James", { selector: "strong" })).toBeInTheDocument();
    await act(async () => {
      completeRefresh({
        title: "Private reviewer",
        subAgentName: "James",
        agentName: "Codex",
      } as Awaited<ReturnType<typeof getSessionSlim>>);
      await refresh;
    });
    vi.mocked(getSessionSlim).mockRejectedValue(new Error("Access revoked"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["peer-source-label"] });
    });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "conversation" })).toHaveTextContent("conversation"),
    );
    expect(screen.getByText("Agent", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("James")).not.toBeInTheDocument();
    expect(screen.queryByText(/Private reviewer/)).not.toBeInTheDocument();
  });
  it.each(["user", "assistant"] as const)(
    "retains %s provenance across history and live item parsing",
    (role) => {
      const item = {
        id: "item-1",
        type: "message",
        role,
        response_id: "peer-turn",
        status: "completed",
        communication,
        content: [
          {
            type: role === "user" ? "input_text" : "output_text",
            text: "Exact report\nwith another line",
          },
        ],
      };
      const history = buildBubbles(itemsToBlocks([item]), null);
      const event = parseEvent("response.output_item.done", { item });
      expect(event).not.toBeNull();
      const live = buildBubbles(new BlockStream().reduceSync([event!]), null);
      for (const bubbles of [history, live]) {
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0]).toMatchObject({ kind: "user", communication, content: item.content });
      }
    },
  );

  it("keeps literal notification-like human text human", () => {
    const bubbles = buildBubbles(
      itemsToBlocks([
        {
          id: "human",
          type: "message",
          role: "user",
          response_id: "r",
          status: "completed",
          user_authored: true,
          content: [
            {
              type: "input_text",
              text: "From Independent review: <task-notification>literal quote</task-notification>",
            },
          ],
        },
      ]),
      null,
    );
    expect(bubbles[0]).toMatchObject({ kind: "user" });
    expect(bubbles[0]).not.toHaveProperty("communication");
    expect(readMessageCommunication("From Independent review")).toBeUndefined();
  });

  it("does not render a long report beyond its bounded preview until expanded", async () => {
    const text = `${"Report α🙂 ".repeat(10000)}FINAL_REPORT_MARKER`;

    render(
      <MemoryRouter>
        <PeerMessage
          communication={communication}
          itemId="long-report"
          content={[{ type: "input_text", text }]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("peer-message")).not.toHaveTextContent("FINAL_REPORT_MARKER");
    expect(screen.getByTestId("peer-message")).not.toHaveTextContent("\uFFFD");
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
    expect(screen.getByTestId("peer-message")).toHaveTextContent("FINAL_REPORT_MARKER");
  });

  it("expands in place with one trailing disclosure and no footer", async () => {
    const text = "First line\nSecond line\nThird line\nFourth line";

    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(60);
    render(
      <MemoryRouter>
        <PeerMessage
          communication={{ ...communication, sent_at: 1_700_000_000 }}
          itemId="item-1"
          content={[{ type: "input_text", text }]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Independent review" })).toHaveAttribute(
      "href",
      "/c/review",
    );
    const disclosure = screen.getByRole("button", { name: "Expand activity" });
    const detail = document.getElementById(disclosure.getAttribute("aria-controls")!);
    expect(detail).not.toBeVisible();
    expect(screen.queryByTestId("message-timestamp")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
    expect(detail).toBeVisible();
    expect(screen.getByTestId("peer-message").textContent?.match(/First line/g)).toHaveLength(1);
    expect(screen.getByTestId("peer-message")).toHaveTextContent("Fourth line");
    expect(screen.getByRole("button", { name: "Collapse activity" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse activity" }));
    expect(detail).not.toBeVisible();
    expect(screen.getByTestId("peer-message").textContent?.match(/First line/g)).toHaveLength(1);
    expect(screen.getByTestId("peer-message")).not.toHaveTextContent("Fourth line");
    expect(
      screen.queryByText(/accepted|queued|Receipt|Delivery|peer-1|Agent message|In transcript/),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["Ada", "James", "Codex", "Ada"],
    [null, "James", "Codex", "James"],
    [null, null, "Researcher", "Researcher"],
    [null, null, null, "Agent"],
  ] as const)(
    "uses recorded identity %s / %s / %s as %s",
    async (sourceAgentName, subAgentName, agentName, expected) => {
      vi.mocked(getSessionSlim).mockResolvedValue({
        title: "Review fork sync",
        subAgentName,
        agentName,
      } as Awaited<ReturnType<typeof getSessionSlim>>);
      render(
        <QueryClientProvider client={queryClient()}>
          <MemoryRouter>
            <PeerMessage
              communication={{ ...communication, source_agent_name: sourceAgentName }}
              itemId="item"
              content={[]}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Review fork sync" })).toHaveTextContent(
          "Review fork sync",
        ),
      );
      expect(screen.getByText(expected, { selector: "strong" })).toBeInTheDocument();
      expect(screen.getByText("from")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Message actions" })).not.toBeInTheDocument();
      fireEvent.contextMenu(screen.getByText(expected, { selector: "strong" }));
      expect(screen.getByRole("menuitem", { name: "Open source chat in new tab" })).toBeVisible();
    },
  );

  it("accepts only a typed structured sender name", () => {
    expect(
      readMessageCommunication({ ...communication, source_agent_name: "Ada" })?.source_agent_name,
    ).toBe("Ada");
    expect(readMessageCommunication({ ...communication, source_agent_name: 42 })).toBeUndefined();
  });

  it("uses an honest native identity fallback without exposing opaque ids", () => {
    render(
      <MemoryRouter>
        <PeerMessage
          communication={{
            ...communication,
            kind: "native_agent",
            source_conversation_id: null,
            source_agent_id: "opaque-agent-uuid",
            source_title: null,
          }}
          itemId="native-item"
          content={[{ type: "input_text", text: "Native report" }]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Agent", { selector: "strong" })).toBeInTheDocument();
    expect(
      screen.queryByText(/opaque-agent-uuid|Agent message|In transcript/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show full|Show less/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-timestamp")).not.toBeInTheDocument();
    expect(getSessionSlim).not.toHaveBeenCalled();
  });

  it("renders markdown and resolves files through the owning message's captured scope", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue({ title: "Review", agentName: "Codex" } as Awaited<
      ReturnType<typeof getSessionSlim>
    >);
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ kind: "missing", path: "/original/workspace/guide.txt" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const view = (scope: string) => (
      <QueryClientProvider client={client}>
        <ConversationScopeContext.Provider value={scope}>
          <MemoryRouter>
            <PeerMessage
              communication={communication}
              itemId="captured-item"
              content={[
                {
                  type: "input_text",
                  text: "Read **this report** and `/original/workspace/guide.txt`.",
                },
              ]}
            />
          </MemoryRouter>
        </ConversationScopeContext.Provider>
      </QueryClientProvider>
    );
    const client = queryClient();
    const rendered = render(view("implementation"));
    expect(screen.getByText("this report")).toHaveAttribute("data-streamdown", "strong");
    const url =
      "/v1/sessions/implementation/attachments/references/captured-item/metadata?path=%2Foriginal%2Fworkspace%2Fguide.txt";
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    rendered.rerender(view("newly-focused-chat"));
    expect(fetch.mock.calls.every(([requested]) => requested === url)).toBe(true);
  });

  it.each(["review", "implementation", "unrelated"])(
    "omits footer nodes in scope %s",
    async (scope) => {
      render(
        <ConversationScopeContext.Provider value={scope}>
          <MemoryRouter>
            <PeerMessage
              communication={communication}
              itemId="item-1"
              content={[{ type: "input_text", text: "Report" }]}
            />
          </MemoryRouter>
        </ConversationScopeContext.Provider>,
      );
      expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("message-timestamp")).not.toBeInTheDocument();
    },
  );

  it("shares a source query, skips hidden chats and never starts a polling timer", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue({ title: "Review", agentName: "Codex" } as Awaited<
      ReturnType<typeof getSessionSlim>
    >);
    const client = queryClient();
    const view = (visible: boolean) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ScopedChatStoreProvider
            conversationId="implementation"
            visible={visible}
            focused={visible}
          >
            {["one", "two"].map((itemId) => (
              <PeerMessage
                key={itemId}
                communication={communication}
                itemId={itemId}
                content={[]}
              />
            ))}
          </ScopedChatStoreProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const rendered = render(view(false));
    expect(getSessionSlim).not.toHaveBeenCalled();
    rendered.rerender(view(true));
    await waitFor(() =>
      expect(screen.getAllByText("Codex", { selector: "strong" })).toHaveLength(2),
    );
    expect(getSessionSlim).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(getSessionSlim).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    rendered.rerender(view(false));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["peer-source-label"] });
    });
    expect(getSessionSlim).toHaveBeenCalledTimes(1);
  });
});
