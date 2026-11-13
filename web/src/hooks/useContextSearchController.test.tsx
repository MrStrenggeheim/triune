// Modified for Triune.
import {
  act,
  cleanup,
  render,
  renderHook,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import type * as HostModule from "@/lib/host";
import { useContextSearchController } from "./useContextSearchController";
import { ContextSearchProvider } from "@/shell/ContextSearchContext";
import { MessageSearchExcerpt, ContextSearchSidebar } from "@/shell/ContextSearchSidebar";
import { ContextSearchBar } from "@/shell/ContextSearchBar";
import type { MessageSearchHit, MessageSearchPage } from "@/shell/contextSearch/types";

const identity = vi.hoisted(() => ({ viewer: "owner", server: "server" }));
vi.mock("./useViewerId", () => ({ useViewerId: () => identity.viewer }));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof HostModule>()),
  getOmnigentServerIdentity: () => identity.server,
}));
vi.mock("@/lib/identity", () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock("./useConversations", () => ({
  SEARCH_FETCH_TIMEOUT_MS: 10000,
  useSessionSearch: () => ({ data: undefined }),
}));
const fetchMock = vi.fn();
const navigate = vi.fn((_path: string, apply: () => void, _isRelevant?: () => boolean) => apply());
const toggle = vi.fn();
const isMobile = vi.fn(() => false);

function hit(item = "m1", session = "chat", text = "needle needle"): MessageSearchHit {
  return {
    session_id: session,
    title: "Chat title",
    item_id: item,
    role: "assistant",
    created_at: 1,
    text,
    snippet: text,
    snippet_start: 0,
    content_hash: "hash",
    ranges: [...text.matchAll(/needle/g)].map((match) => ({
      start: match.index,
      end: match.index + 6,
    })),
    occurrence_count: [...text.matchAll(/needle/g)].length,
  };
}
const page = (
  hits: MessageSearchHit[],
  more = false,
  cursor: string | null = null,
): MessageSearchPage => ({ data: hits, has_more: more, next_cursor: cursor });
const response = (data: MessageSearchPage) => new Response(JSON.stringify(data), { status: 200 });
function useSearchHarness(initiallyOpen = false, activeSessionId = "chat") {
  const [sidebarOpen, setSidebarOpen] = useState(initiallyOpen);
  const search = useContextSearchController({
    activeSessionId,
    sidebarOpen,
    setSidebarOpen,
    navigate,
    onToggleLeftSidebar: toggle,
    onToggleRightSidebar: toggle,
    isMobile,
  });
  return { ...search, controller: search, sidebarOpen, setSidebarOpen };
}
function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
function setup(initiallyOpen = false) {
  const { client, wrapper } = queryWrapper();
  const hook = renderHook(
    ({ activeSessionId }: { activeSessionId: string }) =>
      useSearchHarness(initiallyOpen, activeSessionId),
    { wrapper, initialProps: { activeSessionId: "chat" } },
  );
  return { ...hook, client };
}
function SearchUI() {
  const search = useSearchHarness();
  return (
    <ContextSearchProvider value={search}>
      <button type="button" onClick={() => search.openSearch("current")}>
        Find current
      </button>
      <button type="button" onClick={() => search.openSearch("all")}>
        Find all
      </button>
      <div hidden={!search.sidebarOpen}>
        <ContextSearchSidebar />
      </div>
      <ContextSearchBar />
    </ContextSearchProvider>
  );
}
function setupUI() {
  const { client, wrapper } = queryWrapper();
  render(<SearchUI />, { wrapper });
  return client;
}

async function typeQuery(
  result: ReturnType<typeof setup>["result"],
  scope: "all" | "current" = "current",
  query = "needle",
) {
  act(() => {
    result.current.openSearch(scope);
    result.current.setQuery(query);
  });
  await waitFor(() => expect(result.current.settledQuery).toBe(query));
  await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
}

beforeEach(() => {
  identity.viewer = "owner";
  identity.server = "server";
  fetchMock.mockReset();
  navigate.mockClear();
  isMobile.mockReturnValue(false);
  fetchMock.mockImplementation(() => Promise.resolve(response(page([hit()]))));
});
afterEach(cleanup);

describe("context search navigation and lifecycle", () => {
  it("keeps idle context stable while saved actions use the latest navigation implementation", () => {
    const navigated = vi.fn();
    const toggled = vi.fn();
    const { wrapper } = queryWrapper();
    const { result, rerender } = renderHook(
      ({ version }) =>
        useContextSearchController({
          activeSessionId: "chat",
          sidebarOpen: false,
          setSidebarOpen: () => {},
          navigate: (path, done) => {
            navigated(version, path);
            done();
          },
          onToggleLeftSidebar: () => {},
          onToggleRightSidebar: () => toggled(version),
          isMobile: () => false,
        }),
      { wrapper, initialProps: { version: 1 } },
    );
    const idle = result.current;
    rerender({ version: 2 });
    expect(result.current).toBe(idle);
    act(() => {
      idle.actions.find((action) => action.id === "go-settings")!.run();
      idle.actions.find((action) => action.id === "toggle-right-sidebar")!.run();
      idle.goToTitle("latest-chat");
    });
    expect(navigated.mock.calls).toEqual([
      [2, "/settings"],
      [2, "/c/latest-chat"],
    ]);
    expect(toggled).toHaveBeenCalledWith(2);
    expect(result.current.open).toBe(false);
  });

  it("keeps settled search stable on unrelated renders and follows Current matches through A/B/A", async () => {
    fetchMock.mockImplementation((url: string) => {
      const session = new URL(url, "http://test").searchParams.get("session_id") ?? "chat";
      return Promise.resolve(response(page([hit(`message-${session}`, session)])));
    });
    const { result, rerender } = setup();
    await typeQuery(result);
    await waitFor(() => expect(result.current.highlightTarget?.conversationId).toBe("chat"));
    const before = result.current;
    rerender({ activeSessionId: "chat" });
    expect(result.current.controller).toBe(before.controller);
    expect(result.current.messages).toBe(before.messages);
    expect(result.current.activeMessages).toBe(before.activeMessages);
    expect(result.current.move).toBe(before.move);
    rerender({ activeSessionId: "other" });
    await waitFor(() => expect(result.current.highlightTarget?.conversationId).toBe("other"));
    expect(result.current.highlightTarget?.itemId).toBe("message-other");
    act(() => result.current.move(1));
    expect(result.current.highlightTarget?.range).toEqual({ start: 7, end: 13 });
    rerender({ activeSessionId: "chat" });
    await waitFor(() => expect(result.current.highlightTarget?.conversationId).toBe("chat"));
    expect(result.current.highlightTarget?.itemId).toBe("message-chat");
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.query).toBe("needle");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("includes archived content only for the explicitly selected chat", async () => {
    const { result } = setup();
    await typeQuery(result, "all");
    await waitFor(() => expect(result.current.activeMessages.isSuccess).toBe(true));
    const requests = fetchMock.mock.calls.map(
      ([url]) => new URL(String(url), "http://search.test"),
    );
    const current = requests.find((url) => url.searchParams.get("session_id") === "chat");
    const all = requests.find((url) => !url.searchParams.has("session_id"));
    expect(current?.searchParams.get("include_archived")).toBe("true");
    expect(all?.searchParams.has("include_archived")).toBe(false);
  });

  it("jumps once for a settled Current query, preserves focus ownership across refresh and advances repeated occurrences", async () => {
    const { result, client } = setup();
    await typeQuery(result);
    await waitFor(() => expect(result.current.highlightTarget?.requestId).toBe(1));
    const first = result.current.highlightTarget;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["message-search"] });
    });
    expect(result.current.highlightTarget).toBe(first);
    act(() => result.current.move(1));
    expect(result.current.highlightTarget).toMatchObject({
      itemId: "m1",
      range: { start: 7, end: 13 },
      requestId: 2,
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("All typing never navigates; explicit guarded activation preserves results/query after changing chats", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response(page([hit("other-message", "other")]))),
    );
    const { result, rerender } = setup();
    await typeQuery(result, "all");
    expect(result.current.highlightTarget).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    const hits = result.current.hits;
    let approve: (() => void) | undefined;
    navigate.mockImplementationOnce((_path, apply) => {
      approve = apply;
    });
    act(() => result.current.activate({ hit: hits[0], range: hits[0].ranges[0] }));
    expect(result.current.highlightTarget).toBeNull();
    act(() => approve?.());
    rerender({ activeSessionId: "other" });
    expect(result.current.query).toBe("needle");
    expect(result.current.scope).toBe("all");
    expect(result.current.hits).toBe(hits);
    expect(result.current.highlightTarget?.conversationId).toBe("other");
  });

  it.each([false, true])(
    "temporarily opens/restores sidebar=%s and reinvocation retains scope/query/selection",
    async (initiallyOpen) => {
      const { result } = setup(initiallyOpen);
      await typeQuery(result);
      const target = result.current.highlightTarget;
      act(() => {
        result.current.setSidebarOpen(false);
        result.current.openSearch("all");
      });
      expect(result.current.sidebarOpen).toBe(true);
      expect(result.current.scope).toBe("current");
      expect(result.current.highlightTarget).toBe(target);
      act(() => result.current.close());
      expect(result.current.sidebarOpen).toBe(initiallyOpen);
    },
  );

  it("dismisses a mobile drawer only for explicit activation and retains the match bar state", async () => {
    isMobile.mockReturnValue(true);
    const { result } = setup();
    await typeQuery(result);
    expect(result.current.sidebarOpen).toBe(true);
    act(() => result.current.move(1));
    expect(result.current.sidebarOpen).toBe(false);
    expect(result.current.open).toBe(true);
    expect(result.current.highlightTarget?.requestId).toBe(2);
  });

  it("loads the next active-chat page on Next without crossing conversations or replacing the selected target on pagination", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        response(url.includes("cursor=") ? page([hit("m2")]) : page([hit()], true, "next")),
      ),
    );
    const { result } = setup();
    await typeQuery(result);
    act(() => result.current.move(1));
    expect(result.current.highlightTarget?.itemId).toBe("m1");
    act(() => result.current.move(1));
    await waitFor(() => expect(result.current.highlightTarget?.itemId).toBe("m2"));
    expect(result.current.currentOccurrences).toHaveLength(4);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(["query", "scope", "close"])(
    "cancels delayed result navigation when %s supersedes it",
    async (change) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(response(page([hit("other-message", "other")]))),
      );
      const { result } = setup();
      await typeQuery(result, "all");
      let commit: (() => void) | undefined;
      const opened = vi.fn();
      navigate.mockImplementationOnce((_path, apply, relevant) => {
        commit = () => {
          if (relevant?.() === false) return;
          opened();
          apply();
        };
      });
      const found = result.current.hits[0];
      act(() => result.current.activate({ hit: found, range: found.ranges[0] }));
      act(() => {
        if (change === "query") result.current.setQuery("different");
        else if (change === "scope") result.current.setScope("current");
        else result.current.close();
      });
      act(() => commit?.());
      expect(opened).not.toHaveBeenCalled();
      expect(result.current.highlightTarget).toBeNull();
    },
  );

  it("keeps a navigated current-chat match selected beyond the loaded All page", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        response(
          new URL(url, "http://test").searchParams.get("session_id") === "chat"
            ? page([hit("first", "chat", "needle"), hit("second", "chat", "needle")])
            : page([hit("first", "chat", "needle")], true, "more-global"),
        ),
      ),
    );
    const { result } = setup();
    await typeQuery(result, "all");
    await waitFor(() => expect(result.current.currentOccurrences).toHaveLength(2));
    act(() => result.current.move(1));
    act(() => result.current.move(1));
    expect(result.current.highlightTarget?.itemId).toBe("second");
    expect(result.current.hits.map((entry) => entry.item_id)).toEqual(["first", "second"]);
    expect(result.current.messages.data?.pages[0].data).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores late superseded results and clears search when account/server changes", async () => {
    let finish: ((value: Response) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((url: string, options: RequestInit) => {
      if (url.includes("query=old")) {
        oldSignal = options.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve(response(page([hit("new")])));
    });
    const { result, rerender } = setup();
    act(() => {
      result.current.openSearch("all");
      result.current.setQuery("old");
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await typeQuery(result, "all", "new");
    await act(async () => finish?.(response(page([hit("stale")]))));
    expect(oldSignal?.aborted).toBe(true);
    expect(result.current.hits[0].item_id).toBe("new");
    identity.viewer = "different";
    rerender({ activeSessionId: "chat" });
    expect(result.current.open).toBe(false);
    expect(result.current.query).toBe("");
    identity.server = "other-server";
    rerender({ activeSessionId: "chat" });
    expect(result.current.highlightTarget).toBeNull();
  });

  it("keeps an unavailable target until explicit retry and rejects stale resolution reports", async () => {
    const { result } = setup();
    await typeQuery(result);
    const first = result.current.highlightTarget!;
    act(() => result.current.onHighlightResolved({ target: first, status: "unavailable" }));
    expect(result.current.unavailable).toMatch(/unavailable in the current view/);
    act(() => result.current.move(1));
    act(() => result.current.onHighlightResolved({ target: first, status: "unavailable" }));
    expect(result.current.unavailable).toBeNull();
    expect(result.current.highlightTarget?.requestId).toBe(2);
  });
});

describe("integrated search sidebar and match bar", () => {
  it("resynchronizes a keyboard-selected result with the active occurrence when the bar advances", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response(page([hit(), hit("m2", "chat", "needle second message")]))),
    );
    setupUI();
    fireEvent.click(screen.getByText("Find current"));
    const input = screen.getByRole("textbox", { name: "Search chats" });
    fireEvent.change(input, { target: { value: "needle" } });
    const sidebar = screen.getByTestId("context-search-sidebar");
    const first = await within(sidebar).findByRole("button", { name: /assistant.*needle needle/i });
    await waitFor(() => expect(first).toHaveAttribute("aria-pressed", "true"));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      within(sidebar).getByRole("button", { name: /assistant.*needle second message/i }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await waitFor(() => expect(first).toHaveAttribute("aria-pressed", "true"));
    expect(within(screen.getByRole("search")).getByRole("status")).toHaveTextContent("2 of 3");
  });

  it("retains query input focus during the first jump, synchronizes Enter/Shift+Enter and closes from the bar", async () => {
    setupUI();
    fireEvent.click(screen.getByText("Find current"));
    const input = screen.getByRole("textbox", { name: "Search chats" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "needle" } });
    const bar = screen.getByRole("search", { name: "Find in active chat" });
    await waitFor(() => expect(within(bar).getByRole("status")).toHaveTextContent("1 of 2"));
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(bar).getByRole("status")).toHaveTextContent("2 of 2");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(within(bar).getByRole("status")).toHaveTextContent("1 of 2");
    fireEvent.click(within(bar).getByRole("button", { name: "Close search" }));
    expect(screen.queryByRole("search")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search chats" })).toBeNull();
  });

  it("activates All-chat selection only on Enter and never executes an action from typing/loading/filtering", async () => {
    setupUI();
    fireEvent.click(screen.getByText("Find all"));
    const input = screen.getByRole("textbox", { name: "Search chats" });
    fireEvent.change(input, { target: { value: "settings" } });
    await screen.findByText("Go to Settings");
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Actions", pressed: false }));
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("/settings", expect.any(Function));
  });

  it("renders safe abbreviated excerpts and retries a failed message query without losing the query", async () => {
    fetchMock.mockResolvedValueOnce(new Response("offline", { status: 503 }));
    const client = setupUI();
    fireEvent.click(screen.getByText("Find current"));
    const input = screen.getByRole("textbox", { name: "Search chats" });
    fireEvent.change(input, { target: { value: "needle" } });
    const retry = await within(screen.getByTestId("context-search-sidebar")).findByRole("button", {
      name: "Retry",
    });
    const source =
      "**needle** in `code` ![remote](https://example.test/image.png) <script>attack()</script>";
    fetchMock.mockImplementation(() =>
      Promise.resolve(response(page([hit("safe", "chat", source)]))),
    );
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByTestId("context-search-sidebar")).toHaveTextContent(
        "needle in code remote",
      ),
    );
    expect(
      screen.getByTestId("context-search-sidebar").querySelector("img,script,iframe"),
    ).toBeNull();
    expect(input).toHaveValue("needle");
    const selected = screen.getByRole("button", { name: /Assistant.*needle in code/i });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    const results = screen.getByLabelText("Search results");
    results.scrollTop = 150;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["message-search"] });
    });
    expect(results.scrollTop).toBe(150);
    expect(selected).toHaveAttribute("aria-pressed", "true");
  });
});

describe("message excerpts", () => {
  it.each([
    ["**needle** in [code](https://example.test)", 2, 8, "needle", "needle in code"],
    ["literal ** tokens", 8, 10, "**", "literal ** tokens"],
    ["emoji 😀 result", 6, 8, "😀", "emoji 😀 result"],
    ["İstanbul", 0, 1, "İ", "İstanbul"],
  ])(
    "uses authoritative UTF16 ranges and keeps safe context: %s",
    (text, start, end, match, expected) => {
      const { container } = render(
        <MessageSearchExcerpt hit={{ ...hit(), snippet: text, ranges: [{ start, end }] }} />,
      );
      expect(container).toHaveTextContent(expected);
      expect(container.querySelector("mark")).toHaveTextContent(match);
      expect(container.querySelector("a,img,script")).toBeNull();
    },
  );
});
