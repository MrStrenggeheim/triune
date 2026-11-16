// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import type { ModelUsage } from "@/lib/types";
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
  vi.restoreAllMocks();
});

it("keeps Usage reachable without Notices and separates context, accounting and quota units", async () => {
  useChatStore.setState({ sessionUsageByModel: { model: usage } });
  render(<ConversationHeaderStatus conversationId="header-chat" />, { wrapper });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: /Notices:/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  const context = screen.getByRole("region", { name: "Context usage" });
  expect(context).toHaveTextContent("100 / 1K tokens");
  expect(within(context).getByRole("progressbar", { name: "Context used" })).toHaveAttribute(
    "aria-valuenow",
    "10",
  );
  const accounting = screen.getByRole("region", { name: "Session accounting" });
  expect(accounting).toHaveTextContent("Session cost$1.25 USD");
  expect(accounting).toHaveTextContent("Session tokens120");
  expect(accounting).toHaveTextContent("This session, including descendants");
  expect(screen.getByRole("button", { name: "Token breakdown" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.queryByText("model")).toBeNull();
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Provider quotas" })).getByText("25% used"),
    ).toBeVisible(),
  );
  expect(screen.getByText(/Current availability unconfirmed/)).toBeVisible();
  expect(screen.getByRole("progressbar", { name: "codex primary allowance used" })).toHaveAttribute(
    "aria-valuenow",
    "25",
  );
  expect(screen.queryByText(/Provider status:/)).toBeNull();
  expect(screen.queryByText(/Observed /)).toBeNull();
  expect(screen.queryByText(/Reported window:/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Observation details" }));
  expect(screen.getByText("Provider status: allowed")).toBeVisible();
  expect(screen.getByText("Reported window: 300 minutes")).toBeVisible();
  expect(screen.getByText(/Observed /)).toBeVisible();
  expect(screen.getByText("Source: native")).toBeVisible();
  expect(screen.getAllByText(/Reported reset /)).toHaveLength(1);
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
  fireEvent.click(screen.getByRole("button", { name: "Token breakdown" }));
  expect(screen.getByRole("region", { name: "Session accounting" })).not.toHaveTextContent("$");
  expect(screen.queryByText(/USD/)).toBeNull();
  expect(screen.getByText("No provider quota observation available.")).toBeVisible();
});

it("sums recorded model totals once and discloses exact token buckets without recomputing them", () => {
  const { rerender } = render(
    <ConversationUsageContent
      tokensUsed={81920}
      contextWindow={256000}
      cost={0.84}
      usageByModel={{
        main: {
          ...usage,
          inputTokens: 136000,
          outputTokens: 12000,
          cacheReadInputTokens: 96000,
          cacheCreationInputTokens: null,
          totalTokens: 148000,
          totalCostUsd: 0.84,
        },
        descendant: { ...usage, totalTokens: 2000, totalCostUsd: 0 },
      }}
      quotas={[]}
    />,
    { wrapper },
  );
  const accounting = screen.getByRole("region", { name: "Session accounting" });
  expect(accounting).toHaveTextContent("Session tokens150K");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "32");
  fireEvent.click(screen.getByRole("button", { name: "Token breakdown" }));
  const main = screen.getByRole("heading", { name: "main" }).parentElement!;
  expect(
    within(main)
      .getAllByRole("term")
      .map((row) => row.textContent),
  ).toEqual(["Input", "Output", "Cache read", "Total", "Cost"]);
  expect(
    within(main)
      .getAllByRole("definition")
      .map((row) => row.textContent),
  ).toEqual(["136,000", "12,000", "96,000", "148,000", "$0.84 USD"]);
  const descendant = screen.getByRole("heading", { name: "descendant" }).parentElement!;
  expect(within(descendant).getByText("Cache write")).toBeVisible();
  expect(within(descendant).getByText("$0.00 USD")).toBeVisible();

  rerender(
    <ConversationUsageContent
      tokensUsed={81920}
      contextWindow={256000}
      cost={0.84}
      usageByModel={{ main: { ...usage, totalTokens: 148001 } }}
      quotas={[]}
    />,
  );
  // Background updates retain an open disclosure and expose the exact recorded total.
  expect(screen.getByRole("button", { name: "Token breakdown" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(screen.getByText("148,001")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Token breakdown" }));
  expect(screen.queryByText("148,001")).toBeNull();
});

it.each([null, -1, NaN, Infinity, -Infinity])(
  "omits unknown or invalid accounting and quota fields (%s)",
  (value) => {
    const unknownUsage: ModelUsage = {
      inputTokens: value,
      outputTokens: value,
      totalTokens: value,
      cacheReadInputTokens: value,
      cacheCreationInputTokens: value,
      totalCostUsd: value,
    };
    render(
      <ConversationUsageContent
        tokensUsed={value}
        contextWindow={value}
        cost={value}
        usageByModel={{ unknown: unknownUsage }}
        quotas={[
          {
            ...quota,
            used_percent: value,
            reset_at: value,
            window_minutes: value,
            observed_at: value ?? NaN,
          },
        ]}
      />,
      { wrapper },
    );
    expect(screen.getByText("Context usage unavailable.")).toBeVisible();
    expect(screen.getByText("Session accounting unavailable.")).toBeVisible();
    expect(screen.getByText("Usage unknown")).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Token breakdown" }));
    expect(screen.queryByText("Total")).toBeNull();
    expect(screen.queryByText("Cost")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Observation details" }));
    expect(screen.getByText("Observation time unavailable")).toBeVisible();
    expect(screen.queryByText(/Reported window:/)).toBeNull();
    expect(document.body).not.toHaveTextContent(/NaN|Infinity|Invalid Date|USD|Reported reset/);
  },
);

it("retains valid zero values, including unused context, quotas, cache and session cost", () => {
  render(
    <ConversationUsageContent
      tokensUsed={0}
      contextWindow={1000}
      cost={0}
      usageByModel={{
        zero: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0,
        },
      }}
      quotas={[{ ...quota, used_percent: 0, window_minutes: 0, reset_at: 0, observed_at: 0 }]}
    />,
    { wrapper },
  );
  expect(screen.getByRole("region", { name: "Context usage" })).toHaveTextContent("0 / 1K tokens");
  expect(screen.getByRole("region", { name: "Session accounting" })).toHaveTextContent(
    "Session cost$0.00 USDSession tokens0",
  );
  for (const bar of screen.getAllByRole("progressbar")) {
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuetext", "0% used");
  }
  expect(screen.getByText("Current availability unconfirmed")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Token breakdown" }));
  const model = screen.getByRole("heading", { name: "zero" }).parentElement!;
  expect(
    within(model)
      .getAllByRole("definition")
      .map((row) => row.textContent),
  ).toEqual(["0", "0", "0", "0", "0", "$0.00 USD"]);
  fireEvent.click(screen.getByRole("button", { name: "Observation details" }));
  expect(screen.getByText("Reported window: 0 minutes")).toBeVisible();
  expect(screen.getByText(/Observed /)).toBeVisible();
});

it("does not invent totals from partial buckets, zero capacity or overflowing arithmetic", () => {
  const view = render(
    <ConversationUsageContent
      tokensUsed={100}
      contextWindow={0}
      cost={null}
      usageByModel={{ partial: { ...usage, totalTokens: null } }}
      quotas={[]}
    />,
    { wrapper },
  );
  expect(screen.getByText(/Capacity unavailable/)).toBeVisible();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("Session tokens")).toBeNull();
  expect(screen.queryByText("Session cost")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Token breakdown" }));
  expect(screen.getByText("Cache read")).toBeVisible();
  expect(screen.queryByText("Total")).toBeNull();

  view.rerender(
    <ConversationUsageContent
      tokensUsed={Number.MAX_VALUE}
      contextWindow={Number.MIN_VALUE}
      cost={null}
      usageByModel={{
        one: { ...usage, totalTokens: Number.MAX_VALUE },
        two: { ...usage, totalTokens: Number.MAX_VALUE },
      }}
      quotas={[]}
    />,
  );
  expect(screen.queryByText("Session tokens")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(document.body).not.toHaveTextContent(/NaN|Infinity/);
});

it("keeps quota observations separate, marks only past resets unconfirmed and uses percent used everywhere", () => {
  vi.spyOn(Date, "now").mockReturnValue(1000_000);
  render(
    <ConversationUsageContent
      tokensUsed={1500}
      contextWindow={1000}
      cost={null}
      usageByModel={null}
      quotas={[
        quota,
        {
          ...quota,
          id: "secondary",
          window: "weekly",
          used_percent: 80,
          reset_at: 2000,
          source_kind: "sdk",
        },
        {
          ...quota,
          id: "unknown",
          provider: "other",
          window: "unconfirmed",
          used_percent: 101,
          reset_at: null,
          status: "healthy",
        },
      ]}
    />,
    { wrapper },
  );
  const contextBar = screen.getByRole("progressbar", { name: "Context used" });
  expect(contextBar).toHaveAttribute("aria-valuenow", "100");
  expect(contextBar).toHaveAttribute("aria-valuetext", "150% used");
  expect(screen.getByRole("progressbar", { name: "codex primary allowance used" })).toHaveAttribute(
    "aria-valuetext",
    "25% used",
  );
  expect(screen.getByRole("progressbar", { name: "codex weekly allowance used" })).toHaveAttribute(
    "aria-valuetext",
    "80% used",
  );
  expect(screen.getAllByText("Current availability unconfirmed")).toHaveLength(1);
  expect(screen.getAllByText(/Reported reset /)).toHaveLength(2);
  expect(screen.getByText("Usage unknown")).toBeVisible();
  expect(screen.queryByRole("progressbar", { name: /other/ })).toBeNull();
  expect(screen.queryByText(/Provider status:/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Observation details" }));
  expect(screen.getByText("Provider status: healthy")).toBeVisible();
  expect(screen.getAllByText(/Observed /)).toHaveLength(3);
  expect(screen.getAllByText("Source: sdk")).toHaveLength(1);
  expect(screen.getAllByText(/Reported reset /)).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Observation details" }));
  expect(screen.queryByText(/Provider status:/)).toBeNull();
});

it("keeps Usage read-only, retries failures and renders only known observation fields", async () => {
  fetch.mockResolvedValueOnce(
    Response.json({ detail: "private-provider-detail" }, { status: 500 }),
  );
  const secretQuota = {
    ...quota,
    access_token: "private-provider-detail",
    raw_headers: { authorization: "private-provider-detail" },
  };
  render(<ConversationHeaderStatus conversationId="header-chat" />, { wrapper });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not refresh provider usage.");
  expect(document.body).not.toHaveTextContent("private-provider-detail");
  fetch.mockResolvedValueOnce(Response.json({ data: [], quotas: [secretQuota] }));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("progressbar", { name: "codex primary allowance used" });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Observation details" }));
  expect(document.body).not.toHaveTextContent("private-provider-detail");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    fetch.mock.calls.every(
      ([url, options]) =>
        url === "/v1/sessions/header-chat/runtime-notices" && options?.method === undefined,
    ),
  ).toBe(true);
});

it("does not fetch or expose Usage without read permission", async () => {
  render(<ConversationHeaderStatus conversationId="header-chat" permissionLevel={0} />, {
    wrapper,
  });
  await act(async () => {});
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Usage" })).toBeNull();
});

it.each([401, 403])("hides cached observations after access is revoked (%s)", async (status) => {
  render(<ConversationHeaderStatus conversationId="header-chat" />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  await screen.findByRole("progressbar", { name: "codex primary allowance used" });
  fetch.mockResolvedValueOnce(Response.json({ detail: "Permission denied" }, { status }));
  await act(async () => {
    await client.refetchQueries({ queryKey: ["runtime-notices"] });
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Usage" })).toBeNull());
  expect(screen.queryByRole("dialog", { name: "Conversation usage" })).toBeNull();
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
  expect(screen.getByText("$1.25")).toBeVisible();
  view.rerender(<ConversationHeaderStatus conversationId="header-chat" active={false} />);
  expect(screen.queryByRole("dialog", { name: "Conversation usage" })).toBeNull();
  view.rerender(<ConversationHeaderStatus conversationId="header-chat" active />);
  expect(screen.queryByRole("dialog", { name: "Conversation usage" })).toBeNull();
  view.rerender(<ConversationHeaderStatus conversationId="other-header-chat" />);
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(screen.queryByText("$1.25")).toBeNull();
  expect(screen.getByText("Context usage unavailable.")).toBeVisible();
  await act(async () => {});
});
