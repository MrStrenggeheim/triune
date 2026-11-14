// Modified for Triune.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BubbleView } from "@/pages/ChatPage";
import { useChatStore } from "@/store/chatStore";
import { buildBubbles } from "@/lib/renderItems";
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
    expect(card).toHaveTextContent("Curie · Inspect navigationInspect navigation.Running");
    expect(screen.queryByText(/Keep/)).not.toBeInTheDocument();
    await act(async () =>
      client.setQueryData(childSessionsQueryKey("parent"), [
        { ...summary, busy: false, current_task_status: "completed" },
      ]),
    );
    await waitFor(() => expect(card).toHaveTextContent("Completed"));
    expect(screen.getByTestId("subagent-activity")).toBe(card);
    expect(screen.queryByTestId("subagent-reply")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
    expect(screen.getByText("all instructions")).toHaveAttribute("data-streamdown", "strong");
    fireEvent.click(screen.getByRole("button", { name: "Collapse activity" }));
    expect(screen.queryByText("all instructions")).not.toBeInTheDocument();
  });

  it.each([{ labels: { "omnigent.subagent.dispatch_id": "later" } }, { labels: {} }])(
    "never borrows a later or unidentified dispatch despite an identical description: %j",
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
        "Agent · Inspect navigationDelegated taskStarted",
      );
      expect(screen.queryByText("Running")).not.toBeInTheDocument();
      expect(screen.queryByText("Later name")).not.toBeInTheDocument();
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
    expect(card).toHaveTextContent("Curie · Inspect navigationInspect navigation.Completed");
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
      expect(screen.getByTestId("subagent-reply")).toHaveTextContent(
        `${identity.agent_name} replied`,
      );
      expect(screen.queryByTestId("subagent-activity")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
    expect(reply).toHaveTextContent("FINAL_REPORT_MARKER");
    fireEvent.click(screen.getByRole("button", { name: "Collapse activity" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
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
        fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
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
    expect(screen.getByRole("link", { name: "Inspect Curie in Orchestration" })).toHaveAttribute(
      "href",
      "/c/parent?debug=1&panel=activity&focusAgentId=child",
    );
    fireEvent.click(screen.getByRole("link", { name: "Inspect Curie in Orchestration" }));
    expect(openView).toHaveBeenCalledWith(
      {
        kind: "activity",
        source: { kind: "chat", conversationId: "parent" },
        focusAgentId: "child",
      },
      { beside: true },
    );
    fireEvent.click(screen.getByRole("link", { name: "Open Curie chat beside" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
  const article = screen.getByTestId("subagent-reply");
  rendered.rerender(
    view(activity("returned", { result_text: "One\nTwo\nThree\nFour\n**Late final part**" })),
  );
  expect(screen.getByTestId("subagent-reply")).toBe(article);
  expect(screen.getByRole("button", { name: "Collapse activity" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(await screen.findByText("Late final part")).toHaveAttribute("data-streamdown", "strong");
});
