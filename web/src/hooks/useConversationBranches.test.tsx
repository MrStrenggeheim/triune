import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import type * as IdentityModule from "@/lib/identity";
import { conversation } from "@/test/sidebarMockHelpers";
import type { BranchConversation } from "@/lib/conversationBranches";
import { useConversationBranches } from "./useConversationBranches";

vi.mock("@/lib/identity", async (original) => ({
  ...(await original<typeof IdentityModule>()),
  authenticatedFetch: vi.fn(),
}));

const root = conversation("root");
const rows = [root];
const child = (id: string, parent: string): BranchConversation => ({
  ...conversation(id),
  branch: { source_conversation_id: parent, reference_only: true, recovery: "replay" },
});
const clients: QueryClient[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.clearAllMocks();
});

function renderBranches(filter = "mine", searchQuery = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return renderHook(() => useConversationBranches({ enabled: true, rows, filter, searchQuery }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

it.each(["mine", "shared", "archived"])(
  "exhausts metadata past twenty pages within the %s filter and search scope",
  async (filter) => {
    vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
      const parsed = new URL(String(url), "http://test");
      expect(parsed.pathname).toBe("/v1/sessions");
      expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
        include_side_chats: "true",
        kind: "any",
        visibility: filter,
        search_query: "needle",
      });
      expect(parsed.searchParams.has("include_archived")).toBe(filter === "archived");
      const page = Number(parsed.searchParams.get("after") ?? 0) + 1;
      return new Response(
        JSON.stringify({
          data: [child(String(page), page === 1 ? "root" : String(page - 1))],
          has_more: page < 21,
          last_id: String(page),
        }),
      );
    });
    const { result } = renderBranches(filter, "needle");
    await waitFor(() => expect(result.current.descendantCounts?.get("root")).toBe(21));
    expect(result.current.hasMore).toBe(false);
    expect(authenticatedFetch).toHaveBeenCalledTimes(21);
    expect(result.current.expanded.size).toBe(0);
  },
);

it("withholds partial totals until the last page arrives and deduplicates overlapping pages", async () => {
  let finish!: (response: Response) => void;
  const lastPage = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
    const parsed = new URL(String(url), "http://test");
    if (parsed.searchParams.has("after")) return lastPage;
    return new Response(
      JSON.stringify({
        data: [child("one", "root")],
        has_more: true,
        last_id: "one",
      }),
    );
  });
  const { result } = renderBranches();
  await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
  expect(result.current.rows.map((row) => row.id)).toEqual(["one", "root"]);
  expect(result.current.descendantCounts).toBeNull();
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({
          data: [child("one", "root"), child("two", "one")],
          has_more: false,
          last_id: "two",
        }),
      ),
    ),
  );
  await waitFor(() => expect(result.current.descendantCounts?.get("root")).toBe(2));
});

it("stops a repeated cursor without presenting an incomplete graph as a total", async () => {
  vi.mocked(authenticatedFetch).mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          data: [child("one", "root")],
          has_more: true,
          last_id: "one",
        }),
      ),
  );
  const { result } = renderBranches();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
  expect(result.current.descendantCounts).toBeNull();
});

it("does not treat a missing cursor as a complete graph", async () => {
  vi.mocked(authenticatedFetch).mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          data: [child("one", "root")],
          has_more: true,
          last_id: null,
        }),
      ),
  );
  const { result } = renderBranches();
  await waitFor(() => expect(result.current.rows.some((row) => row.id === "one")).toBe(true));
  expect(result.current.descendantCounts).toBeNull();
  expect(authenticatedFetch).toHaveBeenCalledTimes(1);
});

it("keeps an embedded native child out of sidebar roots", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
    const path = new URL(String(url), "http://test").pathname;
    return new Response(
      JSON.stringify(
        path === "/v1/sessions/native-child"
          ? {
              ...conversation("native-child"),
              parent_session_id: "root",
              labels: { "omnigent.wrapper": "codex-native-ui-subagent" },
            }
          : { data: [], has_more: false, last_id: null },
      ),
    );
  });
  const { result } = renderHook(
    () =>
      useConversationBranches({
        enabled: true,
        rows,
        activeId: "native-child",
        filter: "mine",
        searchQuery: "",
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(result.current.ancestors.some((row) => row.id === "native-child")).toBe(true),
  );
  expect(result.current.rows.map((row) => row.id)).toEqual(["root"]);
});
