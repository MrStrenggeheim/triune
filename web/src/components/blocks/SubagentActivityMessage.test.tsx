// Modified for Triune.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BubbleView } from "@/pages/ChatPage";
import { useChatStore } from "@/store/chatStore";
import { buildBubbles } from "@/lib/renderItems";
import { BlockStream } from "@/lib/blockStream";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import { parseEvent } from "@/lib/sse";
import { WorkbenchProvider } from "@/workbench/WorkbenchContext";
import { SubagentActivityMessage } from "./SubagentActivityMessage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { childSessionsQueryKey } from "@/hooks/useChildSessions";

afterEach(cleanup);
beforeEach(() => useChatStore.setState({ sessionStatus: "idle", conversationId: "parent" }));

describe("sub-agent activity", () => {
  it("updates a delegated card from Running to Completed using only its child summary", async () => {
    const client = new QueryClient();
    const summary = {
      id: "child",
      tool: "James",
      task_summary: "Current task",
      current_task_status: "in_progress",
      busy: true,
    };
    client.setQueryData(childSessionsQueryKey("parent"), [summary]);
    const view = render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <SubagentActivityMessage
            data={{
              type: "resource_event",
              resource_type: "session",
              event_type: "session.subagent.delegated",
              resource_id: "child",
              resource: { task_summary: "Current task" },
            }}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.getByTestId("running-dot")).toBeVisible();
    await act(async () => {
      client.setQueryData(childSessionsQueryKey("parent"), [
        { ...summary, busy: false, current_task_status: "completed" },
      ]);
    });
    await waitFor(() => expect(screen.getByText("Completed")).toBeVisible());
    expect(screen.queryByTestId("running-dot")).not.toBeInTheDocument();
    view.unmount();
    client.clear();
  });

  it("keeps a delegated card neutral when the child summary describes a different task", () => {
    const client = new QueryClient();
    client.setQueryData(childSessionsQueryKey("parent"), [
      {
        id: "child",
        tool: "James",
        task_summary: "New task",
        current_task_status: "in_progress",
        busy: true,
      },
    ]);
    const view = render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <SubagentActivityMessage
            data={{
              type: "resource_event",
              resource_type: "session",
              event_type: "session.subagent.delegated",
              resource_id: "child",
              resource: { task_summary: "Original task" },
            }}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("subagent-activity")).toHaveTextContent(
      "James: Original taskStarted",
    );
    expect(screen.queryByTestId("running-dot")).not.toBeInTheDocument();
    view.unmount();
    client.clear();
  });
  it("keeps the returned task completed when the child is running a different task", () => {
    const client = new QueryClient();
    client.setQueryData(childSessionsQueryKey("parent"), [
      {
        id: "child",
        tool: "James",
        task_summary: "A later task",
        current_task_status: "in_progress",
        busy: true,
      },
    ]);
    const view = render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <SubagentActivityMessage
            data={{
              type: "resource_event",
              resource_type: "session",
              event_type: "session.subagent.returned",
              resource_id: "child",
              resource: { task_summary: "Original task", status: "completed" },
            }}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("subagent-activity")).toHaveTextContent(
      "James: Original taskCompleted",
    );
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.queryByText("A later task")).not.toBeInTheDocument();
    view.unmount();
    client.clear();
  });
  it.each([
    ["delegated", undefined, "Started"],
    ["returned", undefined, "Completed"],
    ["returned", "failed", "Failed"],
    ["returned", "cancelled", "Stopped"],
  ] as const)("renders %s/%s live and after reload as %s", (phase, status, label) => {
    const item = {
      id: "activity",
      type: "resource_event",
      status: "completed",
      response_id: "activity_turn",
      event_type: `session.subagent.${phase}`,
      resource_type: "session",
      resource_id: "conv_child",
      resource: { agent_name: "James", task_summary: "Research public positioning", status },
    };
    const event = parseEvent("response.output_item.done", { item });
    expect(event).not.toBeNull();
    const live = buildBubbles(new BlockStream().reduceSync([event!]), null);
    expect(buildBubbles(itemsToBlocks([item]), null)).toEqual(live);
    expect(live).toHaveLength(1);
    render(
      <MemoryRouter
        initialEntries={["/c/parent?file=README.md&view=terminal&message=msg_parent&debug=1"]}
      >
        <BubbleView bubble={live[0]!} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("subagent-activity")).toHaveTextContent(
      `James: Research public positioning${label}`,
    );
    expect(screen.getByRole("link", { name: "Inspect James in Orchestration" })).toHaveAttribute(
      "href",
      "/c/parent?debug=1&panel=activity&focusAgentId=conv_child",
    );
    expect(screen.queryByTestId("message-bubble")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("opens the matching completed target in its source Orchestration view with one action", () => {
    const openView = vi.fn();
    render(
      <MemoryRouter>
        <WorkbenchProvider value={{ openView, openConversation: vi.fn() }}>
          <SubagentActivityMessage
            data={{
              type: "resource_event",
              resource_type: "session",
              event_type: "session.subagent.returned",
              resource_id: "child",
              resource: {
                agent_name: "Gibbs",
                task_summary: "Check navigation",
                status: "completed",
              },
            }}
          />
        </WorkbenchProvider>
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);
    fireEvent.click(screen.getByRole("link", { name: "Inspect Gibbs in Orchestration" }));
    expect(openView).toHaveBeenCalledWith(
      {
        kind: "activity",
        source: { kind: "chat", conversationId: "parent" },
        focusAgentId: "child",
      },
      { beside: true },
    );
    fireEvent.click(screen.getByRole("link", { name: "Open Gibbs chat beside" }));
    expect(openView).toHaveBeenLastCalledWith(
      { kind: "conversation", conversationId: "child", title: "Gibbs" },
      { beside: true },
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("uses the observed phase when a legacy event has no recorded task description", () => {
    render(
      <MemoryRouter>
        <SubagentActivityMessage
          data={{
            type: "resource_event",
            resource_type: "session",
            event_type: "session.subagent.delegated",
            resource_id: "child",
            resource: { title: "Ambiguous old label" },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("subagent-activity")).toHaveTextContent("Agent: Delegated task");
    expect(screen.queryByText("Ambiguous old label")).not.toBeInTheDocument();
  });

  it("keeps dispatch identity and expandable input/result after the child is reused", () => {
    const client = new QueryClient();
    client.setQueryData(childSessionsQueryKey("parent"), [
      {
        id: "child",
        agent_name: "Later name",
        task_summary: "Later task",
        busy: true,
        labels: { "omnigent.subagent.dispatch_id": "dispatch-2" },
      },
    ]);
    const fullInput = "Inspect the original navigation task. ".repeat(10);
    const fullResult = "Original clean result. ".repeat(10);
    const view = render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <SubagentActivityMessage
            data={{
              type: "resource_event",
              resource_type: "session",
              event_type: "session.subagent.returned",
              resource_id: "child",
              resource: {
                agent_name: "Curie",
                task_summary: "Original task",
                dispatch_id: "dispatch-1",
                task_input: fullInput,
                result_text: fullResult,
              },
            }}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("subagent-activity")).toHaveTextContent("Curie: Original task");
    expect(screen.queryByText("Later name")).not.toBeInTheDocument();
    expect(screen.queryByText("Later task")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
    expect(screen.getByText(fullInput.trim())).toBeVisible();
    expect(screen.getByText(fullResult.trim())).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Collapse activity" }));
    expect(screen.queryByText(fullInput.trim())).not.toBeInTheDocument();
    view.unmount();
    client.clear();
  });

  it.each([
    { event_type: "session.resource.created", resource_type: "terminal", resource_id: "term_1" },
    { event_type: "session.subagent.delegated", resource_type: "session", resource_id: "" },
  ])("ignores unrelated or malformed resource events: %j", (fields) => {
    const item = {
      id: "resource",
      type: "resource_event",
      response_id: "activity",
      status: "completed",
      ...fields,
    };
    expect(itemsToBlocks([item])).toEqual([]);
    expect(parseEvent("response.output_item.done", { item })).toBeNull();
  });
});
