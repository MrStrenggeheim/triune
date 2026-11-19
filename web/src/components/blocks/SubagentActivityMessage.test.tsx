// Modified for Triune.
import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BubbleView } from "@/pages/ChatPage";
import { bubbleKey } from "@/components/chat/chatBubbleParts";
import { useChatStore } from "@/store/chatStore";
import { findMessageElement } from "@/lib/messageDeepLink";
import { createBubbleCache, buildBubbles } from "@/lib/renderItems";
import { BlockStream } from "@/lib/blockStream";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import { parseEvent } from "@/lib/sse";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { WorkbenchProvider } from "@/workbench/WorkbenchContext";
import { childSessionsQueryKey } from "@/hooks/useChildSessions";
import { SubagentActivityMessage } from "./SubagentActivityMessage";

const clients: QueryClient[] = [];
function queryClient(summary: Record<string, unknown>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  client.setQueryData(childSessionsQueryKey("parent"), [summary]);
  clients.push(client);
  return client;
}
function activity(
  phase: "delegated" | "returned",
  resource: Record<string, unknown> = {},
  id: string = phase,
) {
  return {
    id,
    type: "resource_event",
    status: "completed",
    response_id: `activity_${id}`,
    created_at: 1_700_000_000,
    event_type: `session.subagent.${phase}`,
    resource_type: "session",
    resource_id: "child",
    resource: {
      agent_name: "Curie",
      task_summary: "Inspect navigation",
      dispatch_id: "dispatch-1",
      ...resource,
    },
  };
}
const originalInput =
  "Inspect navigation.\n\nKeep **all instructions** behind deliberate expansion.";
const summary = {
  id: "child",
  agent_name: "Curie",
  task_summary: "Inspect navigation",
  current_task_status: "in_progress",
  busy: true,
  labels: { "omnigent.subagent.dispatch_id": "dispatch-1" },
};
beforeEach(() =>
  useChatStore.setState({ sessionStatus: "idle", conversationId: "parent", blocks: [] }),
);
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sub-agent task and reply", () => {
  it.each(["delegated", "returned"] as const)(
    "replaces generic %s attribution when the same dispatch receives its native nickname",
    async (phase) => {
      const client = queryClient(summary);
      const data = activity(phase, {
        agent_name: "Codex",
        agent_name_source: "role",
        task_summary: "orchestration_header_intake",
        task_input: originalInput,
        result_text: phase === "returned" ? "Original captured report" : undefined,
      });
      render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <SubagentActivityMessage data={data} />
          </QueryClientProvider>
        </MemoryRouter>,
      );
      const card = screen.getByTestId(
        phase === "delegated" ? "subagent-activity" : "subagent-reply",
      );
      expect(card).toHaveTextContent("Curie");
      fireEvent.click(
        screen.getByRole("button", {
          name: `Expand activity · Curie ${phase === "delegated" ? "task" : "reply"}`,
        }),
      );
      await act(async () =>
        client.setQueryData(childSessionsQueryKey("parent"), [
          {
            ...summary,
            labels: {
              ...summary.labels,
              "omnigent.codex_native.agent_nickname": "Hooke",
            },
          },
        ]),
      );
      await waitFor(() => expect(card).toHaveTextContent("Hooke"));
      expect(
        screen.getByRole("button", {
          name: `Collapse activity · Hooke ${phase === "delegated" ? "task" : "reply"}`,
        }),
      ).toBeInTheDocument();
      if (phase === "delegated") {
        expect(card).toHaveTextContent("Inspect navigation");
        expect(card).toHaveTextContent("all instructions");
      } else expect(card).toHaveTextContent("Original captured report");
      expect(data.resource.agent_name).toBe("Codex");
    },
  );

  it("updates the same dispatch from Running to Completed without showing instructions or an empty reply", async () => {
    const client = queryClient(summary);
    const delegated = activity("delegated", { task_input: originalInput });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <SubagentActivityMessage data={delegated} />
          <SubagentActivityMessage data={activity("returned", { status: "completed" })} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const card = screen.getByTestId("subagent-activity");
    expect(card).toHaveTextContent(
      "Curie · Inspect navigationInstruction: Inspect navigation. Keep all instructions behind deliberate expansion.Running",
    );
    expect(card.querySelector(".resource-description")).toHaveTextContent(
      "Instruction: Inspect navigation. Keep all instructions behind deliberate expansion.",
    );
    await act(async () =>
      client.setQueryData(childSessionsQueryKey("parent"), [
        { ...summary, busy: false, current_task_status: "completed" },
      ]),
    );
    await waitFor(() => expect(card).toHaveTextContent("Completed"));
    expect(screen.getByTestId("subagent-activity")).toBe(card);
    expect(screen.queryByTestId("subagent-reply")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand activity · Curie task" }));
    expect(card.querySelector('[data-streamdown="strong"]')).toHaveTextContent("all instructions");
    fireEvent.click(screen.getByRole("button", { name: "Collapse activity · Curie task" }));
    expect(card.querySelector('[data-streamdown="strong"]')).not.toBeInTheDocument();
  });

  it.each([{ labels: { "omnigent.subagent.dispatch_id": "later" } }, { labels: {} }])(
    "keeps current child identity and lifecycle across dispatches: %j",
    (fields) => {
      const client = queryClient({ ...summary, ...fields, agent_name: "Later name" });
      render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <SubagentActivityMessage data={activity("delegated", { agent_name: undefined })} />
          </QueryClientProvider>
        </MemoryRouter>,
      );
      expect(screen.getByTestId("subagent-activity")).toHaveTextContent(
        "Later name · Inspect navigationNo captured messageRunning",
      );
      expect(screen.getByText("Running")).toBeVisible();
      expect(screen.getByText("Later name")).toBeVisible();
    },
  );

  it("keeps recorded title and completion after reuse and puts the answer at the returned position", () => {
    const delegated = activity("delegated", { task_input: originalInput });
    const returned = activity("returned", {
      status: "completed",
      result_text: "The **original result**.",
    });
    useChatStore.setState({ blocks: itemsToBlocks([delegated, returned]) });
    const client = queryClient({
      ...summary,
      task_summary: "Later task",
      labels: { "omnigent.subagent.dispatch_id": "dispatch-2" },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <SubagentActivityMessage data={delegated} />
          <p>Parent continued</p>
          <SubagentActivityMessage data={returned} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId("subagent-activity")).toHaveLength(1);
    const card = screen.getByTestId("subagent-activity");
    const reply = screen.getByTestId("subagent-reply");
    expect(card).toHaveTextContent(
      "Curie · Later taskInstruction: Inspect navigation. Keep all instructions behind deliberate expansion.Completed",
    );
    expect(card).not.toHaveTextContent("original result");
    expect(reply).toHaveTextContent("Curie replied");
    expect(reply).not.toHaveTextContent("Inspect navigation");
    expect(reply.previousElementSibling).toHaveTextContent("Parent continued");
    expect(screen.getByText("original result")).toHaveAttribute("data-streamdown", "strong");
    expect(screen.queryByText("Later task")).not.toBeInTheDocument();
    expect(screen.queryByTestId("peer-message")).not.toBeInTheDocument();
  });

  it("enriches a late report in place and renders one answer for duplicate returns", () => {
    const delegated = activity("delegated");
    const returned = activity("returned", { status: "completed" });
    useChatStore.setState({ blocks: itemsToBlocks([delegated, returned]) });
    const view = (data: ReturnType<typeof activity>, duplicate = false) => (
      <MemoryRouter>
        <SubagentActivityMessage data={delegated} />
        <SubagentActivityMessage data={data} />
        {duplicate && (
          <SubagentActivityMessage
            data={activity("returned", { result_text: "Late answer" }, "duplicate")}
          />
        )}
      </MemoryRouter>
    );
    const rendered = render(view(returned));
    expect(screen.queryByTestId("subagent-reply")).not.toBeInTheDocument();
    const enriched = activity("returned", { status: "completed", result_text: "Late answer" });
    act(() =>
      useChatStore.setState({
        blocks: itemsToBlocks([
          delegated,
          enriched,
          activity("returned", { result_text: "Late answer" }, "duplicate"),
        ]),
      }),
    );
    rendered.rerender(view(enriched, true));
    expect(screen.getAllByTestId("subagent-reply")).toHaveLength(1);
    expect(screen.getByTestId("subagent-activity")).toHaveTextContent("Completed");
    rendered.rerender(view(enriched, true));
    expect(screen.getAllByText("Late answer")).toHaveLength(1);
  });

  it.each([
    { agent_name: "James", agent_role: "worker", agent_name_source: "native" },
    { agent_name: "Researcher", agent_role: "researcher", agent_name_source: "role" },
    { agent_name: "Ada", agent_role: "plugin:reviewer", agent_name_source: "native" },
  ])(
    "preserves recorded Codex/managed/Claude attribution through live parsing and reload: %j",
    (identity) => {
      const item = activity("returned", {
        ...identity,
        result_text: "Exact **answer**",
        result_finality: "final_answer",
        turn_id: "exact-turn",
        result_position: 7,
        result_ref: { conversation_id: "child", item_id: "exact-answer" },
        status: "completed",
      });
      const event = parseEvent("response.output_item.done", { item });
      expect(event).not.toBeNull();
      const live = buildBubbles(new BlockStream().reduceSync([event!]), null);
      expect(buildBubbles(itemsToBlocks([item]), null)).toEqual(live);
      expect(live).toHaveLength(1);
      render(
        <MemoryRouter>
          <BubbleView bubble={live[0]!} />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole("button", { name: /^1 subagent$/ }));
      expect(screen.getByTestId("subagent-activity")).toHaveTextContent(
        `${identity.agent_name} · Inspect navigationReply: Exact answer`,
      );
      expect(screen.queryByTestId("subagent-reply")).not.toBeInTheDocument();
      expect(screen.queryByTestId("message-timestamp")).not.toBeInTheDocument();
    },
  );

  it.each([undefined, "completed", "failed", "cancelled"])(
    "status-only %s returns never manufacture an answer",
    (status) => {
      render(
        <MemoryRouter>
          <SubagentActivityMessage data={activity("returned", { status, result_text: "   " })} />
        </MemoryRouter>,
      );
      expect(screen.queryByTestId("subagent-reply")).not.toBeInTheDocument();
      expect(screen.queryByTestId("subagent-activity")).not.toBeInTheDocument();
    },
  );

  it("bounds a long Markdown preview and expands in place without footer controls", async () => {
    const text = `**Report**\n\n${"Report α🙂 ".repeat(12000)}FINAL_REPORT_MARKER`;

    render(
      <MemoryRouter>
        <SubagentActivityMessage data={activity("returned", { result_text: text })} />
      </MemoryRouter>,
    );
    const reply = screen.getByTestId("subagent-reply");
    expect(reply).not.toHaveTextContent("FINAL_REPORT_MARKER");
    expect(reply).not.toHaveTextContent("\uFFFD");
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand activity · Curie reply" }));
    expect(reply).toHaveTextContent("FINAL_REPORT_MARKER");
    fireEvent.click(screen.getByRole("button", { name: "Collapse activity · Curie reply" }));
    expect(reply).not.toHaveTextContent("FINAL_REPORT_MARKER");
  });

  it("expands full Markdown with tables and code without a message footer", async () => {
    const text =
      "Intro\n\n**Details**\n\n| State | Result |\n| --- | --- |\n| Done | Correct |\n\n```ts\nconst result = 1;\n```";

    render(
      <MemoryRouter>
        <SubagentActivityMessage data={activity("returned", { result_text: text })} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand activity · Curie reply" }));
    expect(screen.getByRole("table")).toHaveTextContent("DoneCorrect");
    expect(screen.getByTestId("subagent-reply").textContent?.match(/Intro/g)).toHaveLength(1);
    expect(screen.getByText("Details")).toHaveAttribute("data-streamdown", "strong");
    expect(screen.getByTestId("subagent-reply").querySelector("pre")).toHaveTextContent(
      "const result = 1;",
    );
    expect(screen.queryByTestId("message-timestamp")).not.toBeInTheDocument();
  });

  it.each(["task_input_ref", "result_ref"])(
    "uses the exact %s conversation/item for Markdown without a message footer",
    async (field) => {
      const fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ kind: "missing", path: "/original/guide.txt" }), {
          headers: { "Content-Type": "application/json" },
        }),
      );

      vi.stubGlobal("fetch", fetch);

      const client = queryClient(summary);
      const data = activity(field === "task_input_ref" ? "delegated" : "returned", {
        [field]: { conversation_id: "original", item_id: "captured-item" },
        task_input: "Read **instructions** and `/original/guide.txt`.",
        result_text: "Read **answer** and `/original/guide.txt`.",
      });
      const view = (scope: string) => (
        <QueryClientProvider client={client}>
          <ConversationScopeContext.Provider value={scope}>
            <MemoryRouter>
              <SubagentActivityMessage data={data} />
            </MemoryRouter>
          </ConversationScopeContext.Provider>
        </QueryClientProvider>
      );
      const rendered = render(view("parent"));
      if (field === "task_input_ref")
        fireEvent.click(screen.getByRole("button", { name: "Expand activity · Curie task" }));
      const url =
        "/v1/sessions/original/attachments/references/captured-item/metadata?path=%2Foriginal%2Fguide.txt";
      await waitFor(() => expect(fetch).toHaveBeenCalledWith(url, expect.anything()));
      rendered.rerender(view("newly-focused-chat"));
      expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
      expect(
        fetch.mock.calls
          .filter(([requested]) => String(requested).includes("/attachments/"))
          .every(([requested]) => requested === url),
      ).toBe(true);
    },
  );

  it.each(["delegated", "returned"] as const)("retains both navigation controls on %s", (phase) => {
    const openView = vi.fn();
    render(
      <MemoryRouter initialEntries={["/c/parent?file=README.md&debug=1"]}>
        <WorkbenchProvider value={{ openView, openConversation: vi.fn() }}>
          <SubagentActivityMessage data={activity(phase, { result_text: "Answer" })} />
        </WorkbenchProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Show Curie in Orchestration" })).toHaveAttribute(
      "href",
      "/c/parent?debug=1&panel=activity&focusAgentId=child",
    );
    fireEvent.click(screen.getByRole("link", { name: "Show Curie in Orchestration" }));
    expect(openView).toHaveBeenCalledWith(
      {
        kind: "activity",
        conversationId: "parent",
        linkRequestId: expect.any(String),
        source: { kind: "chat", conversationId: "parent" },
        focusAgentId: "child",
      },
      { beside: true },
    );
    fireEvent.click(screen.getByRole("link", { name: "Open chat beside · Curie" }));
    expect(openView).toHaveBeenLastCalledWith(
      { kind: "conversation", conversationId: "child", title: "Curie" },
      { beside: true },
    );
  });

  it("keeps an ambiguous legacy title neutral instead of borrowing current child identity", () => {
    render(
      <MemoryRouter>
        <SubagentActivityMessage
          data={activity("delegated", {
            agent_name: null,
            task_summary: null,
            title: "Ambiguous old label",
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("subagent-activity")).toHaveTextContent("Agent · Delegated task");
    expect(screen.queryByText("Ambiguous old label")).not.toBeInTheDocument();
  });

  it.each([
    { event_type: "session.resource.created", resource_type: "terminal", resource_id: "term_1" },
    { event_type: "session.subagent.delegated", resource_type: "session", resource_id: "" },
  ])("ignores unrelated or malformed events: %j", (fields) => {
    const item = { ...activity("delegated"), ...fields };
    expect(itemsToBlocks([item])).toEqual([]);
    expect(parseEvent("response.output_item.done", { item })).toBeNull();
  });
});

it("resolves each multipart report section against its own exact source item", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ kind: "missing", path: "/original/guide.txt" }), {
      headers: { "Content-Type": "application/json" },
    }),
  );

  vi.stubGlobal("fetch", fetch);

  const first = "First **section** cites `/original/guide.txt`.\n\nContinued.\n\nStill first.";
  const second = "Second section cites `/original/guide.txt`.";
  const text = `${first}\n\n${second}`;
  const data = activity("returned", {
    result_text: text,
    result_ref: { conversation_id: "original", item_id: "first" },
    result_refs: [
      { conversation_id: "original", item_id: "first" },
      { conversation_id: "original", item_id: "second" },
    ],
    result_parts: [
      { conversation_id: "original", item_id: "first", text: first },
      { conversation_id: "original", item_id: "second", text: second },
    ],
  });
  render(
    <QueryClientProvider client={queryClient(summary)}>
      <MemoryRouter>
        <SubagentActivityMessage data={data} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/v1/sessions/original/attachments/references/first/metadata?path=%2Foriginal%2Fguide.txt",
      expect.anything(),
    ),
  );
  expect(screen.queryByText(/Second section/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand activity · Curie reply" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/v1/sessions/original/attachments/references/second/metadata?path=%2Foriginal%2Fguide.txt",
      expect.anything(),
    ),
  );
  expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
});

it("keeps an expanded reply open as late report text enriches the same event", async () => {
  const original = activity("returned", { result_text: "One\nTwo\nThree\nFour" });
  const view = (data: ReturnType<typeof activity>) => (
    <MemoryRouter>
      <SubagentActivityMessage data={data} />
    </MemoryRouter>
  );
  const rendered = render(view(original));
  fireEvent.click(screen.getByRole("button", { name: "Expand activity · Curie reply" }));
  const article = screen.getByTestId("subagent-reply");
  rendered.rerender(
    view(activity("returned", { result_text: "One\nTwo\nThree\nFour\n**Late final part**" })),
  );
  expect(screen.getByTestId("subagent-reply")).toBe(article);
  expect(screen.getByRole("button", { name: "Collapse activity · Curie reply" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(await screen.findByText("Late final part")).toHaveAttribute("data-streamdown", "strong");
});

it("updates one plain-timeline card per child through spawn, repeated steering and late status", () => {
  const events = [
    activity(
      "delegated",
      { task_summary: "Navigation review", task_input: "Original handoff" },
      "spawn",
    ),
    activity(
      "delegated",
      {
        dispatch_id: "steer-1",
        task_summary: "Working agreement update",
        task_input: "First steering details",
      },
      "steer-1",
    ),
    {
      ...activity(
        "delegated",
        { dispatch_id: "another", task_summary: "Independent research" },
        "another",
      ),
      resource_id: "second-child",
    },
    activity(
      "delegated",
      {
        dispatch_id: "steer-2",
        task_summary: "Shared parse blocker",
        task_input: "Second steering details",
      },
      "steer-2",
    ),
    activity("returned", { dispatch_id: "dispatch-1", status: "completed" }, "late-old-return"),
    activity("returned", { dispatch_id: "steer-2", status: "completed" }, "last-return"),
  ];
  const cache = createBubbleCache();
  const view = (count: number) => {
    const blocks = itemsToBlocks(events.slice(0, count));
    useChatStore.setState({ blocks });
    const bubbles = buildBubbles(blocks, null, cache);
    expect(bubbles).toEqual(buildBubbles(blocks, null));
    return (
      <MemoryRouter>
        {bubbles.map((bubble) => (
          <BubbleView key={bubbleKey(bubble)} bubble={bubble} />
        ))}
      </MemoryRouter>
    );
  };
  const rendered = render(view(1));
  fireEvent.click(screen.getByRole("button", { name: /^1 subagent$/ }));
  const original = screen.getByTestId("subagent-activity");
  for (let count = 2; count <= events.length; count++) {
    act(() => rendered.rerender(view(count)));
    const cards = screen.getAllByTestId("subagent-activity");
    expect(cards).toHaveLength(count >= 3 ? 2 : 1);
    expect(cards[0]).toBe(original);
    expect(cards[0]).toHaveTextContent("Navigation review");
    expect(cards[0]).not.toHaveTextContent("Working agreement update");
    expect(cards[0]).not.toHaveTextContent("Shared parse blocker");
  }
  expect(original).toHaveTextContent("Completed");
  expect(findMessageElement("spawn")).toBe(original);
  expect(findMessageElement("steer-1")).toBe(original);
  expect(findMessageElement("steer-2")).toBe(original);
  fireEvent.click(within(original).getByRole("button", { name: "Expand activity · Curie task" }));
  expect(original).toHaveTextContent("Original handoff");
  expect(original).toHaveTextContent("First steering details");
  expect(original).toHaveTextContent("Second steering details");
});

it.each([
  "Delegated task",
  "Please inspect the entire navigation and preserve all original instructions. ".repeat(4),
])("lets the generated short summary replace legacy/pending metadata: %s", async (legacy) => {
  const client = queryClient({
    ...summary,
    task_summary: legacy,
    labels: { "omnigent.subagent.card_summary": legacy },
  });
  const data = activity("delegated", {
    task_summary: legacy,
    card_summary: legacy,
    task_input: originalInput,
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SubagentActivityMessage data={data} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await act(async () =>
    client.setQueryData(childSessionsQueryKey("parent"), [
      {
        ...summary,
        task_summary: "Navigation review",
        labels: { "omnigent.subagent.card_summary": legacy },
      },
    ]),
  );
  expect(await screen.findByText("· Navigation review")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Expand activity · Curie task" }));
  expect(screen.getByTestId("subagent-activity")).toHaveTextContent("all instructions");
});

it("keeps the full latest message in expanded details and absorbs a real final into the spawn", async () => {
  const records = [
    activity("delegated", {
      task_input: "Full **instruction**",
      task_input_position: 1,
      task_input_ref: { conversation_id: "child", item_id: "source-input" },
    }),
    activity("returned", {
      result_text: "Final **reply**",
      result_finality: "final_answer",
      result_position: 3,
      turn_id: "turn",
      result_ref: { conversation_id: "child", item_id: "source-result" },
    }),
  ];
  const blocks = itemsToBlocks(records);
  useChatStore.setState({ blocks });
  const bubbles = buildBubbles(blocks, null);
  render(
    <MemoryRouter>
      {bubbles.map((bubble) => (
        <BubbleView key={bubbleKey(bubble)} bubble={bubble} />
      ))}
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^1 subagent$/ }));
  expect(screen.getAllByTestId("subagent-activity")).toHaveLength(1);
  expect(screen.queryByTestId("subagent-reply")).not.toBeInTheDocument();
  const preview = screen.getByTestId("subagent-activity").querySelector(".resource-description");
  expect(preview).toHaveTextContent("Reply: Final reply");
  fireEvent.click(screen.getByRole("button", { name: "Expand activity · Curie task" }));
  expect(preview).not.toBeInTheDocument();
  expect(await screen.findByText("instruction")).toBeVisible();
  expect(screen.getByText("reply", { selector: '[data-streamdown="strong"]' })).toBeVisible();
  expect(findMessageElement("returned")).toBe(screen.getByTestId("subagent-activity"));
});
