// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import { useChatStore } from "@/store/chatStore";
import { WorkbenchProvider } from "@/workbench/WorkbenchContext";
import { ConversationHeaderStatus, ConversationUsageContent } from "./ConversationHeaderStatus";

vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
  getCurrentUserId: () => "header-status-viewer",
}));
const fetch = vi.mocked(authenticatedFetch);
let client: QueryClient;
const quota = {
  id: "quota-primary",
  provider: "codex",
  window: "primary",
  used_percent: 25,
  reset_at: 100,
  window_minutes: 300,
  status: "allowed",
  observed_at: 50,
  source_kind: "native" as const,
};
const usage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cacheReadInputTokens: 10,
  cacheCreationInputTokens: 0,
  totalCostUsd: 1.25,
};
const warning = {
  id: "provider-warning",
  title: "Usage limit approaching",
  message: "Provider reports a warning.",
  severity: "warning",
  category: "quota",
  source_kind: "native",
  created_at: 50,
  blocking: null,
};
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetch.mockReset().mockResolvedValue(Response.json({ data: [], quotas: [quota] }));
  useChatStore.setState({
    conversationId: "header-chat",
    tokensUsed: 100,
    contextWindow: 1000,
    sessionCostUsd: 1.25,
    sessionUsageByModel: null,
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});

it("keeps Usage reachable without Notices and separates context, accounting and quota units", async () => {
  useChatStore.setState({ sessionUsageByModel: { model: usage } });
  render(<ConversationHeaderStatus conversationId="header-chat" />, { wrapper });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: /Notices:/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(
    within(screen.getByRole("region", { name: "Context usage" })).getByText(/100 tokens/),
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Session accounting" })).getByText("Cost: $1.25 USD"),
  ).toBeVisible();
  expect(screen.getByTestId("agent-info-usage-by-model")).toBeInTheDocument();
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Provider quotas" })).getByText(
        "25% of reported allowance used",
      ),
    ).toBeVisible(),
  );
  expect(screen.getByText(/Current availability unconfirmed/)).toBeVisible();
});

it("does not relabel Kiro credits as dollars or invent missing context capacity", () => {
  render(
    <ConversationUsageContent
      tokensUsed={100}
      contextWindow={null}
      cost={50}
      usageByModel={{ model: { ...usage, totalCostUsd: 50 } }}
      quotas={[]}
      harness="kiro-native-ui"
    />,
    { wrapper },
  );
  expect(screen.getByText(/Capacity unavailable/)).toBeVisible();
  expect(screen.getByTestId("agent-info-usage-by-model")).not.toHaveTextContent("$");
  expect(screen.queryByText(/USD/)).toBeNull();
  expect(screen.getByText("No provider quota observation available.")).toBeVisible();
});

it("keeps notice dismissal UI-only and opens the captured conversation's Agent CLI", async () => {
  fetch.mockResolvedValue(Response.json({ data: [warning], quotas: [quota] }));
  const openView = vi.fn();
  render(
    <WorkbenchProvider value={{ openView, openConversation: vi.fn() }}>
      <ConversationHeaderStatus conversationId="notice-header-chat" />
    </WorkbenchProvider>,
    { wrapper },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Notices: 1" }));
  expect(screen.getByText("Provider reports a warning.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open Agent CLI" }));
  expect(openView).toHaveBeenCalledExactlyOnceWith(
    { kind: "agent-terminal", conversationId: "notice-header-chat", title: "Agent CLI" },
    { beside: true },
  );
  fireEvent.click(screen.getByRole("button", { name: "Notices: 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /Notices:/ })).toBeNull());
  expect(screen.getByRole("button", { name: "Usage" })).toBeVisible();
  expect(fetch.mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);
});

it("closes inactive popovers and never displays another conversation's cached accounting", async () => {
  const view = render(<ConversationHeaderStatus conversationId="header-chat" />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(screen.getByText("Cost: $1.25 USD")).toBeVisible();
  view.rerender(<ConversationHeaderStatus conversationId="header-chat" active={false} />);
  expect(screen.queryByRole("dialog", { name: "Conversation usage" })).toBeNull();
  view.rerender(<ConversationHeaderStatus conversationId="header-chat" active />);
  expect(screen.queryByRole("dialog", { name: "Conversation usage" })).toBeNull();
  view.rerender(<ConversationHeaderStatus conversationId="other-header-chat" />);
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(screen.queryByText("Cost: $1.25 USD")).toBeNull();
  expect(screen.getByText("Context usage unavailable.")).toBeVisible();
  await act(async () => {});
});
