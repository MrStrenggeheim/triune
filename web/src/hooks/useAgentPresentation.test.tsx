// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { useAgentPresentation } from "./useAgentPresentation";
import { AgentResourceRow } from "@/shell/ChatActivityPanel";
import { SubagentActivityMessage } from "@/components/blocks/SubagentActivityMessage";
import { PeerMessage } from "@/components/blocks/PeerMessage";
import type { ChildSessionInfo } from "./useChildSessions";
import * as sessionsApi from "@/lib/sessionsApi";

vi.mock("@/lib/sessionsApi", async (original) => ({
  ...(await original<typeof sessionsApi>()),
  getSessionSlim: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("converges actual card, peer, Orchestration and shelf row values from the same parent cache without per-row fetching", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  const child: ChildSessionInfo = {
    id: "child",
    title: "Full task",
    agent_name: "codex-native-ui",
    task_summary: "Inspect navigation",
    tool: "codex-native-ui",
    session_name: "task",
    current_task_status: "completed",
    busy: false,
    last_message_preview: "Reply: Latest report",
    pending_elicitations_count: 0,
    labels: {
      "omnigent.wrapper": "codex-native-ui-subagent",
      "omnigent.codex_native.agent_nickname": "Curie",
    },
  };
  client.setQueryData(["conversation", "parent", "child_sessions"], [child]);
  vi.mocked(sessionsApi.getSessionSlim).mockImplementation(
    async (id) =>
      ({
        id,
        title: id === "parent" ? "Main planning" : "Full task",
        labels: id === "child" ? child.labels : {},
        agentName: "codex-native-ui",
        subAgentName: null,
      }) as Awaited<ReturnType<typeof sessionsApi.getSessionSlim>>,
  );
  useChatStore.setState({ conversationId: "parent", blocks: [], sessionStatus: "idle" });
  const data = {
    id: "dispatch",
    type: "resource_event",
    resource_type: "session",
    resource_id: "child",
    event_type: "session.subagent.delegated",
    resource: {
      agent_name: "codex-native-ui",
      task_summary: "Stale task",
      dispatch_id: "dispatch",
      card_dispatches: [],
    },
  };
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <section aria-label="Card">
          <SubagentActivityMessage data={data} />
        </section>
        <section aria-label="Peer">
          <PeerMessage
            communication={{
              kind: "peer",
              message_id: "peer",
              source_conversation_id: "parent",
              destination_conversation_id: "child",
              source_agent_name: "codex-native-ui",
              delivery_state: "confirmed",
            }}
            content={[]}
            itemId="peer"
          />
        </section>
        <section aria-label="Orchestration">
          <AgentResourceRow child={child} conversationId="parent" onOpen={() => {}} />
        </section>
        <section aria-label="Shelf">
          <AgentResourceRow child={child} conversationId="parent" onOpen={() => {}} />
        </section>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  for (const name of ["Card", "Peer", "Orchestration", "Shelf"]) {
    const surface = screen.getByRole("region", { name });
    expect(within(surface).getByText("Curie", { exact: false })).toBeInTheDocument();
    expect(surface).toHaveTextContent("Inspect navigation");
    expect(surface).toHaveTextContent("Reply: Latest report");
  }
  act(() =>
    client.setQueryData(
      ["conversation", "parent", "child_sessions"],
      [
        {
          ...child,
          labels: {
            ...child.labels,
            "omnigent.codex_native.agent_nickname": "Boole",
            "omnigent.subagent.card_summary": "Review focus",
          },
          last_message_preview: "Instruction: Continue review",
        },
      ],
    ),
  );
  for (const name of ["Card", "Peer", "Orchestration", "Shelf"]) {
    const surface = screen.getByRole("region", { name });
    expect(surface).toHaveTextContent("Boole");
    expect(surface).toHaveTextContent("Review focus");
    expect(surface).toHaveTextContent("Instruction: Continue review");
    expect(surface).not.toHaveTextContent("Latest report");
  }
  await screen.findByText("Main planning", { selector: "strong" });
  expect(sessionsApi.getSessionSlim).toHaveBeenCalledTimes(2);
  client.clear();
});
it("ignores another captured parent's cache and observes late session renames without fetching", () => {
  const client = new QueryClient();
  client.setQueryData(["session", "named"], {
    title: "Original chat",
    agentName: "codex-native-ui",
  });
  function Probe() {
    const display = useAgentPresentation("named", "captured-parent");
    return <output>{display.name}</output>;
  }
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Original chat");
  act(() =>
    client.setQueryData(
      ["conversation", "other-parent", "child_sessions"],
      [{ id: "named", agent_name: "Wrong source" }],
    ),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Original chat");
  act(() =>
    client.setQueryData(["session", "named"], {
      title: "Renamed chat",
      agentName: "codex-native-ui",
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Renamed chat");
  client.clear();
});
