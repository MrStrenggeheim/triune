// Modified for Triune.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import * as TooltipPrimitive from "radix-ui/tooltip";

import { CommandPalette } from "./CommandPalette";
import { SearchIcon } from "lucide-react";
import { FALLBACK_SERVER_INFO } from "@/lib/capabilities";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import type { MessageSearchHit } from "./contextSearch/types";

const useMessageSearch = vi.fn();
const useMessageSearchNotice = vi.fn();
const contextSearch = vi.fn(() => null as Record<string, unknown> | null);
vi.mock("@/hooks/useMessageSearch", () => ({
  useMessageSearch: (...args: unknown[]) => useMessageSearch(...args),
  useMessageSearchIdentity: () => "server:viewer",
  useMessageSearchNotice: (...args: unknown[]) => useMessageSearchNotice(...args),
}));
vi.mock("./ContextSearchContext", () => ({ useContextSearch: () => contextSearch() }));

function messageHit(
  id = "m1",
  title = "Chat title",
  text = "needle excerpt",
  created_at = 10,
): MessageSearchHit {
  const matches = [...text.matchAll(/needle|deploy|what|match|older-query/gi)];
  return {
    kind: "message",
    session_id: id,
    title,
    item_id: `item-${id}`,
    role: "assistant",
    sender_name: "Codex",
    created_at,
    text,
    content_hash: `hash-${id}`,
    snippet: text,
    snippet_start: 0,
    ranges: matches.map((match) => ({ start: match.index, end: match.index + match[0].length })),
    occurrence_count: matches.length,
  };
}
function titleHit(id = "title", title = "needle plan", created_at = 20): MessageSearchHit {
  return {
    ...messageHit(id, title, "Latest preview message", created_at),
    kind: "chat",
    ranges: [],
    occurrence_count: 0,
    title_ranges: [{ start: 0, end: 6 }],
  };
}
function setMessageResults(hits: MessageSearchHit[], state: Record<string, unknown> = {}) {
  useMessageSearch.mockReturnValue({
    data: { pages: [{ data: hits }] },
    isFetching: false,
    ...state,
  });
}
function search(term: string) {
  fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: term } });
  act(() => vi.advanceTimersByTime(300));
}

const useWorkspaceFileSearch = vi.fn();
vi.mock("@/hooks/useWorkspaceChangedFiles", () => ({
  useWorkspaceFileSearch: (...args: unknown[]) => useWorkspaceFileSearch(...args),
}));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => false }));

const navigate = vi.fn();
vi.mock("@/lib/routing", () => ({
  useNavigate: () => navigate,
}));

const useConversations = vi.fn();
const useSessionSearch = vi.fn();
const serverInfo = vi.fn();
vi.mock("@/lib/CapabilitiesContext", () => ({
  useServerInfo: () => serverInfo(),
}));
vi.mock("@/hooks/useConversations", () => ({
  useConversations: (...args: unknown[]) => useConversations(...args),
  useSessionSearch: (...args: unknown[]) => useSessionSearch(...args),
}));

function conv(
  id: string,
  title: string | null,
  agent_name: string | null = null,
  search_snippet: string | null = null,
) {
  return { id, title, agent_name, archived: false, search_snippet };
}

function setSessions(sessions: ReturnType<typeof conv>[], isFetching = false) {
  useConversations.mockReturnValue({ data: { pages: [{ data: sessions }] }, isFetching });
}

type SearchGroupState = Record<string, unknown>;

/** Serve each typed-search group (`title` / `content` / `all`) its own hook state. */
function setSearchGroups({
  title = {},
  content = {},
  all = {},
}: {
  title?: SearchGroupState;
  content?: SearchGroupState;
  all?: SearchGroupState;
}) {
  const groups: Record<string, SearchGroupState> = { title, content, all };
  useSessionSearch.mockImplementation((_query: string, scope: string) => ({
    isFetching: false,
    ...groups[scope],
  }));
}

function searchPages(...pages: ReturnType<typeof conv>[][]) {
  return { data: { pages: pages.map((data) => ({ data })) } };
}

const SEARCH_GROUP_OPTIONS = { enabled: true, limit: 8, cacheIdentity: "server:viewer" };

/** Find a session row by its full label text even when the highlighter has
    split it around a <mark> (so the text lives across several nodes). */
function labelRow(text: string) {
  return screen.getByText((_content, el) => el?.tagName === "SPAN" && el.textContent === text);
}

function renderPalette(overrides: Partial<ComponentProps<typeof CommandPalette>> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onToggleLeftSidebar: vi.fn(),
    onToggleRightSidebar: vi.fn(),
    ...overrides,
  };
  render(<CommandPalette {...props} />);
  return props;
}

beforeEach(() => {
  navigate.mockClear();
  contextSearch.mockReturnValue(null);
  useMessageSearch.mockReset();
  useMessageSearchNotice.mockClear();
  setMessageResults([]);
  useWorkspaceFileSearch
    .mockReset()
    .mockReturnValue({ data: { files: [], truncated: false }, isFetching: false });
  useConversations.mockReset();
  useSessionSearch.mockReset();
  serverInfo.mockReturnValue({ session_search_scope: true });
  setSessions([]);
  setSearchGroups({});
});
afterEach(cleanup);

describe("CommandPalette — sessions", () => {
  it.each([false, true])(
    "requests active sessions and keeps owned and shared results (sessionsOnly=%s)",
    (sessionsOnly) => {
      const sessions = [
        { ...conv("owned", "Owned session"), owner: "current-user", permission_level: 4 },
        { ...conv("shared", "Shared session"), owner: "other-user", permission_level: 2 },
        { ...conv("archived", "Archived session"), archived: true },
      ];
      setSessions(sessions);
      renderPalette({ sessionsOnly });

      expect(useConversations).toHaveBeenCalledWith("", false, { enabled: true });
      expect(screen.getByText("Owned session")).toBeTruthy();
      expect(screen.getByText("Shared session")).toBeTruthy();
      expect(screen.queryByText("Archived session")).toBeNull();
    },
  );

  it("searches subchat and delegate titles on the server without a content group", () => {
    vi.useFakeTimers();
    try {
      setSessions([conv("recent", "Recent parent")]);
      setSearchGroups({
        title: searchPages([conv("child", "Parser subchat"), conv("delegate", "Parser delegate")]),
        content: searchPages([conv("body-only", "Unrelated", null, "Parser")]),
      });
      const { onOpenChange } = renderPalette({ sessionsOnly: true });
      expect(screen.getByText("Recent parent")).toBeTruthy();
      fireEvent.change(screen.getByTestId("command-palette-input"), {
        target: { value: "Parser" },
      });
      expect(screen.queryByText("Recent parent")).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(300));
      expect(useSessionSearch).toHaveBeenCalledWith("Parser", "title", SEARCH_GROUP_OPTIONS);
      expect(labelRow("Parser subchat")).toBeTruthy();
      expect(labelRow("Parser delegate")).toBeTruthy();
      expect(screen.queryByText("Unrelated")).toBeNull();
      expect(screen.queryByText("In messages")).toBeNull();
      expect(screen.queryByText("Go to Inbox")).toBeNull();
      fireEvent.keyDown(screen.getByTestId("command-palette-input"), { key: "Enter" });
      expect(navigate).toHaveBeenCalledWith("/c/child");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads later recent pages while idle and stops loading while closed", () => {
    const fetchNextPage = vi.fn();
    useConversations.mockReturnValue({
      data: { pages: [{ data: [] }] },
      isFetching: false,
      hasNextPage: true,
      fetchNextPage,
    });
    const props = {
      open: true,
      sessionsOnly: true,
      onOpenChange: vi.fn(),
      onToggleLeftSidebar: vi.fn(),
      onToggleRightSidebar: vi.fn(),
    };
    const { rerender } = render(<CommandPalette {...props} />);
    expect(useConversations).toHaveBeenCalledWith("", false, { enabled: true });
    expect(fetchNextPage).toHaveBeenCalledOnce();
    useConversations.mockReturnValue({
      data: { pages: [{ data: [] }, { data: [conv("older", "Older session")] }] },
      isFetching: false,
      hasNextPage: false,
      fetchNextPage,
    });
    rerender(<CommandPalette {...props} />);
    expect(screen.getByText("Older session")).toBeTruthy();
    rerender(<CommandPalette {...props} open={false} />);
    expect(useConversations).toHaveBeenLastCalledWith("", false, { enabled: false });
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });

  it("does not retry a failed pagination request indefinitely", () => {
    const fetchNextPage = vi.fn();
    useConversations.mockReturnValue({
      data: { pages: [] },
      isFetching: false,
      hasNextPage: true,
      isFetchNextPageError: true,
      fetchNextPage,
    });
    renderPalette({ sessionsOnly: true });
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Couldn't load");
    expect(screen.queryByText("No results found")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "shows initial fetch errors with a retry (sessionsOnly=%s)",
    (sessionsOnly) => {
      const refetch = vi.fn();
      useConversations.mockReturnValue({ isError: true, isFetching: false, refetch });
      renderPalette({ sessionsOnly });
      expect(screen.getByRole("status").textContent).toContain("Couldn't load sessions.");
      expect(screen.queryByText("No results found")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(refetch).toHaveBeenCalledOnce();
    },
  );

  it("shows only one loading message during the initial session fetch", () => {
    setSessions([], true);
    renderPalette({ sessionsOnly: true });
    expect(screen.getByRole("status").textContent).toBe("Loading sessions…");
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByText("No results found")).toBeNull();
  });

  it("bounds automatic pagination and lets the user search older sessions", () => {
    const fetchNextPage = vi.fn();
    useConversations.mockReturnValue({
      data: {
        pages: Array.from({ length: 10 }, () => ({ data: [conv("repeated", "Repeated page")] })),
      },
      hasNextPage: true,
      isFetching: false,
      fetchNextPage,
    });
    renderPalette({ sessionsOnly: true });
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(screen.getAllByText("Repeated page")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Search older sessions" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });

  it("bounds idle rows but uses server results rather than the loaded cache for typed titles", () => {
    vi.useFakeTimers();
    try {
      setSessions(Array.from({ length: 100 }, (_, i) => conv(`c${i}`, `Session ${i}`)));
      setSearchGroups({ title: searchPages([conv("remote-child", "Session 99 subchat")]) });
      renderPalette({ sessionsOnly: true });
      expect(screen.getAllByRole("option")).toHaveLength(50);
      expect(screen.getByRole("status").textContent).toContain("Showing 50 of 100 matches.");
      fireEvent.change(screen.getByTestId("command-palette-input"), {
        target: { value: "Session 99" },
      });
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(labelRow("Session 99 subchat")).toBeTruthy();
      fireEvent.keyDown(screen.getByTestId("command-palette-input"), { key: "Enter" });
      expect(navigate).toHaveBeenCalledWith("/c/remote-child");
    } finally {
      vi.useRealTimers();
    }
  });
  it("lists recent display labels without a harness badge", () => {
    setSessions([conv("c1", "Fix the parser", "research-agent"), conv("c2", null)]);
    renderPalette();

    expect(screen.getByText("Fix the parser")).toBeTruthy();
    expect(screen.queryByText("research-agent")).toBeNull();
    // Null title → conversationDisplayLabel's "New session" fallback.
    expect(screen.getByText("New session")).toBeTruthy();
  });

  it("navigates to the session and closes when an item is selected", () => {
    setSessions([conv("c1", "Fix the parser")]);
    const onOpenChange = vi.fn();
    renderPalette({ onOpenChange });

    fireEvent.click(screen.getByText("Fix the parser"));

    expect(navigate).toHaveBeenCalledWith("/c/c1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("debounces the typed query into a server search (archived excluded)", () => {
    vi.useFakeTimers();
    try {
      setSessions([conv("c1", "Fix the parser")]);
      renderPalette();

      expect(useConversations).toHaveBeenCalledWith("", false, { enabled: true });

      fireEvent.change(screen.getByTestId("command-palette-input"), {
        target: { value: "deploy" },
      });
      // Before the debounce elapses the query has NOT yet reached the search.
      expect(useSessionSearch).not.toHaveBeenCalledWith("deploy", "title", SEARCH_GROUP_OPTIONS);

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(useMessageSearch).toHaveBeenCalledWith(
        "deploy",
        undefined,
        true,
        "server:viewer",
        "all",
      );
      expect(useSessionSearch.mock.calls.some(([, , options]) => options.enabled)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the Sessions group above Actions", () => {
    setSessions([conv("c1", "Fix the parser")]);
    renderPalette();

    // Group order matters: the palette doubles as the sidebar's session-search
    // entry point, so Sessions must come before the static Actions.
    const headings = screen.getAllByText(/^(Sessions|Actions)$/).map((el) => el.textContent);
    expect(headings).toEqual(["Sessions", "Actions"]);
  });

  it("caps the session list to 5 while the query is empty, lifting it on type", () => {
    vi.useFakeTimers();
    try {
      const many = Array.from({ length: 8 }, (_, i) => conv(`c${i}`, `Session ${i}`, "agent"));
      setSessions(many);
      setMessageResults(
        many.map((row, index) => ({
          ...messageHit(row.id, row.title ?? ""),
          created_at: 100 - index,
        })),
      );
      renderPalette();

      // Empty query: only the first 5 recent sessions show, so the Actions
      // group below stays visible without scrolling.
      expect(screen.getByText("Session 0")).toBeTruthy();
      expect(screen.getByText("Session 4")).toBeTruthy();
      expect(screen.queryByText("Session 5")).toBeNull();

      // Typing lifts the cap — finding a specific session is now the point.
      fireEvent.change(screen.getByTestId("command-palette-input"), {
        target: { value: "session" },
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // The label is now split around the highlighted query term
      // (`<mark>Session</mark> 5`), so match on the row's combined text.
      expect(screen.getByText("Session 5")).toBeTruthy();
      expect(screen.getByText("Session 7")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes sessions that appear on overlapping pages", () => {
    useConversations.mockReturnValue({
      data: {
        pages: [{ data: [conv("c1", "One")] }, { data: [conv("c1", "One"), conv("c2", "Two")] }],
      },
      isFetching: false,
    });
    renderPalette();

    expect(screen.getAllByText("One")).toHaveLength(1);
    expect(screen.getByText("Two")).toBeTruthy();
  });

  it("indents session rows so their label aligns with the icon-prefixed actions", () => {
    setSessions([conv("c1", "Fix the parser")]);
    renderPalette();

    // Session items carry no leading icon, so they're padded to line up with
    // the Action rows' icon + gap. Assert the class so the alignment can't
    // silently regress.
    const item = screen.getByText("Fix the parser").closest("[data-slot=command-item]");
    expect(item?.className).toContain("pl-6");
  });
});

describe("CommandPalette — shared result rows", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows sender, actual date/time and a single truncated accent excerpt", () => {
    const hit = messageHit("body", "Weekly sync", "**needle** in `code`", 1736935500);
    setMessageResults([hit]);
    renderPalette();
    search("needle");
    const row = document.querySelector('[data-search-result="message"]')!;
    expect(row).toHaveTextContent("Weekly sync: Codex");
    expect(row.querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(1736935500000).toISOString(),
    );
    expect(row.querySelector("time")).toHaveTextContent(
      new Date(1736935500000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
    );
    expect(row.querySelector("mark")).toHaveClass(
      "font-semibold",
      "text-primary",
      "bg-transparent",
    );
    expect(row.lastElementChild).toHaveClass("truncate");
    expect(screen.queryByText("In messages")).toBeNull();
  });

  it("highlights title ranges and shows the last-message preview for chat hits", () => {
    setMessageResults([titleHit()]);
    const onMessageSearch = vi.fn();
    const { onOpenChange } = renderPalette({ onMessageSearch });
    search("needle");
    const row = document.querySelector('[data-search-result="chat"]')!;
    expect(row.querySelector("mark")).toHaveTextContent("needle");
    expect(row).toHaveTextContent("Latest preview message");
    fireEvent.click(row);
    expect(navigate).toHaveBeenCalledWith("/c/title");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onMessageSearch).not.toHaveBeenCalled();
  });
});

describe("CommandPalette — input", () => {
  it("uses the sessions-first placeholder", () => {
    renderPalette();

    expect(screen.getByPlaceholderText("Search sessions or run a command")).toBeTruthy();
  });
});

describe("CommandPalette — mobile full-screen sheet", () => {
  // useIsMobileViewport reads window.matchMedia("(max-width: 767.98px)").matches.
  // The global test-setup stubs matchMedia to always report false (desktop);
  // flip it here so the palette renders its keyboard-safe mobile layout.
  function setMobile(isMobile: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: isMobile,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  function dialogContent() {
    return document.querySelector("[data-slot=dialog-content]");
  }

  afterEach(() => setMobile(false));

  it("renders a top-anchored full-screen sheet with a close button on mobile", () => {
    setMobile(true);
    renderPalette();

    // The sheet drops the centered-card geometry (top-1/4 → top-0, rounded → none)
    // so it fills the keyboard-aware viewport instead of hiding behind the keyboard.
    const content = dialogContent();
    expect(content?.className).toContain("rounded-none");
    expect(content?.className).not.toContain("top-1/4");
    // …and offers an explicit close affordance (no ⌘K/Esc hint on touch).
    expect(screen.getByLabelText("Close search")).toBeTruthy();
  });

  it("keeps the centered dialog and shows no close button on desktop", () => {
    setMobile(false);
    renderPalette();

    expect(dialogContent()?.className).toContain("top-1/4");
    expect(screen.queryByLabelText("Close search")).toBeNull();
  });

  it("anchors workbench search below its trigger without a blocking backdrop", () => {
    setMobile(false);
    const anchor = document.createElement("button");
    anchor.dataset.workbenchSearch = "";
    anchor.getBoundingClientRect = () => new DOMRect(180, 0, 300, 48);
    document.body.appendChild(anchor);
    try {
      renderPalette({ anchorSelector: "[data-workbench-search]" });
      expect(screen.getByRole("dialog")).toHaveStyle({
        top: "56px",
        left: `${(window.innerWidth - Math.min(640, window.innerWidth - 16)) / 2}px`,
      });
      expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
      expect(screen.getByTestId("command-palette-input")).toHaveFocus();
      fireEvent.keyDown(screen.getByTestId("command-palette-input"), { key: "Escape" });
    } finally {
      anchor.remove();
    }
  });

  it("closes the palette when the mobile close button is tapped", () => {
    setMobile(true);
    const onOpenChange = vi.fn();
    renderPalette({ onOpenChange });

    fireEvent.click(screen.getByLabelText("Close search"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("still searches from the mobile input", () => {
    vi.useFakeTimers();
    try {
      setMobile(true);
      setSessions([conv("c1", "Fix the parser")]);
      renderPalette();

      fireEvent.change(screen.getByTestId("command-palette-input"), {
        target: { value: "deploy" },
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(useMessageSearch).toHaveBeenCalledWith(
        "deploy",
        undefined,
        true,
        "server:viewer",
        "all",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CommandPalette — unified results", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("preserves globally ordered message/title rows and deduplicates overlapping pages by kind", () => {
    const first = messageHit("same", "Newest", "needle newest", 30);
    const title = { ...titleHit("same", "needle title", 20), item_id: first.item_id };
    const last = messageHit("last", "Oldest", "needle oldest", 10);
    setMessageResults([], { data: { pages: [{ data: [first, title] }, { data: [title, last] }] } });
    renderPalette();
    search("needle");
    expect(
      [...document.querySelectorAll("[data-search-result]")].map(
        (row) => row.textContent?.split(":")[0],
      ),
    ).toEqual(["Newest", "needle title", "Oldest"]);
    expect(document.querySelectorAll("[cmdk-group-heading]").length).toBe(0);
    expect(document.querySelector("[cmdk-list]")).toHaveAttribute("data-scrollbar", "hidden");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("hands the exact captured occurrence and filter to the parent", () => {
    const hit = {
      ...messageHit(),
      text_start: 100,
      text: "needle excerpt",
      ranges: [{ start: 100, end: 106 }],
      snippet_start: 100,
    };
    setMessageResults([hit]);
    const onMessageSearch = vi.fn();
    renderPalette({ onMessageSearch });
    search("needle");
    fireEvent.click(screen.getByRole("button", { name: "Final" }));
    expect(useMessageSearch).toHaveBeenLastCalledWith(
      "needle",
      undefined,
      true,
      "server:viewer",
      "final",
    );
    expect(onMessageSearch).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("command-palette-input"), { key: "Enter" });
    expect(onMessageSearch).toHaveBeenCalledExactlyOnceWith(
      "m1",
      "needle",
      {
        conversationId: "m1",
        itemId: "item-m1",
        range: { start: 100, end: 106 },
        sourceText: "needle excerpt",
        content_hash: "hash-m1",
        textStart: 100,
        requestId: 0,
      },
      "final",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shares scope/filter with the controller and omits the current chat prefix", () => {
    const setMessageFilter = vi.fn(),
      setScope = vi.fn();
    contextSearch.mockReturnValue({
      scope: "current",
      activeSessionId: "chat",
      messageFilter: "user",
      setMessageFilter,
      setScope,
    });
    setMessageResults([messageHit()]);
    renderPalette();
    search("needle");
    expect(useMessageSearch).toHaveBeenLastCalledWith(
      "needle",
      "chat",
      true,
      "server:viewer",
      "user",
    );
    expect(screen.queryByText("Chat title")).toBeNull();
    expect(document.querySelector("[data-search-result]")).toHaveTextContent("Codex");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(setMessageFilter).toHaveBeenCalledWith("all");
    fireEvent.click(screen.getByRole("button", { name: "All chats" }));
    expect(setScope).toHaveBeenCalledWith("all");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps keyboard selection during a background update and resumes from the last loaded row", () => {
    const fetchNextPage = vi.fn();
    const first = messageHit("first", "First"),
      second = messageHit("second", "Second");
    setMessageResults([first, second], { hasNextPage: true, fetchNextPage });
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      onToggleLeftSidebar: vi.fn(),
      onToggleRightSidebar: vi.fn(),
      onMessageSearch: vi.fn(),
    };
    const { rerender } = render(<CommandPalette {...props} />);
    search("needle");
    const input = screen.getByTestId("command-palette-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.querySelector('[cmdk-item][data-selected="true"]')).toHaveTextContent("Second");
    fireEvent.pointerMove(screen.getByText("Show more"));
    fireEvent.click(screen.getByText("Show more"));
    expect(fetchNextPage).toHaveBeenCalledOnce();
    setMessageResults([first, second, messageHit("third", "Third")]);
    rerender(<CommandPalette {...props} />);
    expect(document.querySelector('[cmdk-item][data-selected="true"]')).toHaveTextContent("Second");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.querySelector('[cmdk-item][data-selected="true"]')).toHaveTextContent("Third");
  });

  it.each([{ open: false }, { sessionsOnly: true }])(
    "disables unified search outside an open global palette: %o",
    (overrides) => {
      renderPalette(overrides);
      expect(useMessageSearch.mock.lastCall?.[2]).toBe(false);
    },
  );

  it("routes actual query errors to shared notices without routine unavailable labels", () => {
    const state = { isError: true, error: new Error("offline") };
    setMessageResults([], state);
    renderPalette();
    search("needle");
    expect(useMessageSearchNotice.mock.lastCall?.[1]).toBe(true);
    expect(useMessageSearchNotice.mock.lastCall?.[0].error).toBe(state.error);
    expect(screen.queryByText(/Match unavailable|Search unavailable/)).toBeNull();
  });
});

describe("CommandPalette — actions", () => {
  it("lists the built-in action commands", () => {
    renderPalette();

    expect(screen.getByText("New chat")).toBeTruthy();
    expect(screen.getByText("Go to Inbox")).toBeTruthy();
    expect(screen.getByText("Go to Settings")).toBeTruthy();
    expect(screen.getByText("Toggle conversations sidebar")).toBeTruthy();
    expect(screen.getByText("Toggle workspace sidebar")).toBeTruthy();
  });

  it("runs a navigation action and closes the palette", () => {
    const onOpenChange = vi.fn();
    renderPalette({ onOpenChange });

    fireEvent.click(screen.getByText("Go to Settings"));

    expect(navigate).toHaveBeenCalledWith("/settings");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("invokes the sidebar-toggle callbacks", () => {
    const onToggleLeftSidebar = vi.fn();
    const onToggleRightSidebar = vi.fn();
    renderPalette({ onToggleLeftSidebar, onToggleRightSidebar });

    fireEvent.click(screen.getByText("Toggle conversations sidebar"));
    expect(onToggleLeftSidebar).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Toggle workspace sidebar"));
    expect(onToggleRightSidebar).toHaveBeenCalledTimes(1);
  });

  it("filters actions client-side against the query", () => {
    renderPalette();

    fireEvent.change(screen.getByTestId("command-palette-input"), {
      target: { value: "settings" },
    });

    expect(screen.getByText("Go to Settings")).toBeTruthy();
    expect(screen.queryByText("New chat")).toBeNull();
  });
});

describe("CommandPalette — empty state", () => {
  it("shows an empty state when nothing matches", () => {
    setSessions([]);
    renderPalette();

    // A query that matches no action and no session.
    fireEvent.change(screen.getByTestId("command-palette-input"), {
      target: { value: "zzzznomatch" },
    });

    expect(screen.getByText("No results found")).toBeTruthy();
  });
});

describe("CommandPalette — explicit file targets and workflow commands", () => {
  const workspace: WorkbenchWorkspace = {
    id: "workspace-a",
    root: "/root",
    host_id: "host-a",
    target_kind: "host",
    capabilities: ["files"],
  };
  const file = (path: string) => ({
    path,
    name: path.split("/").at(-1),
    type: "file",
    bytes: 1,
    modified_at: 1,
  });
  const type = (value: string) =>
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value } });
  const settle = () =>
    act(() => {
      vi.advanceTimersByTime(300);
    });
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("locates files only in the supplied workspace/folder and opens only on selection", () => {
    useWorkspaceFileSearch.mockReturnValue({ data: { files: [file("src/parser.ts")] } });
    const onOpenFile = vi.fn(),
      onFileSearch = vi.fn();
    const target = { workspace, conversationId: "captured-chat", folder: "/root/project" };
    const props = renderPalette({ fileTarget: target, onOpenFile, onFileSearch });
    type("parser");
    expect(screen.queryByText("src/parser.ts")).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    settle();
    expect(useWorkspaceFileSearch).toHaveBeenLastCalledWith(
      "captured-chat",
      "parser",
      undefined,
      undefined,
      { enabled: true, workspace },
      "/root/project",
    );
    expect(onFileSearch).not.toHaveBeenCalled();
    fireEvent.click(labelRow("src/parser.ts"));
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("src/parser.ts", target);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("passes null workspace for explicit chat resources and never inherits an ambient target", () => {
    renderPalette({ fileTarget: { conversationId: "chat-a" }, onOpenFile: vi.fn() });
    type("readme");
    settle();
    expect(useWorkspaceFileSearch).toHaveBeenLastCalledWith(
      "chat-a",
      "readme",
      undefined,
      undefined,
      { enabled: true, workspace: null },
      "",
    );
  });

  it.each([undefined, {}, { conversationId: "temp:creating" }])(
    "does not search without an authoritative target: %o",
    (fileTarget) => {
      renderPalette({ fileTarget, onOpenFile: vi.fn() });
      type("readme");
      settle();
      expect(useWorkspaceFileSearch.mock.lastCall?.[4]).toEqual({
        enabled: false,
        workspace: null,
      });
    },
  );

  it("never opens stale rows while the query, folder or target is changing", () => {
    useWorkspaceFileSearch.mockReturnValue({ data: { files: [file("old.ts")] } });
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      onToggleLeftSidebar: vi.fn(),
      onToggleRightSidebar: vi.fn(),
      onOpenFile: vi.fn(),
      fileTarget: { workspace, folder: "/first" },
    };
    const { rerender } = render(<CommandPalette {...props} />);
    type("old");
    settle();
    expect(labelRow("old.ts")).toBeTruthy();
    type("new");
    expect(screen.queryByText("old.ts")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("command-palette-input"), { key: "Enter" });
    expect(props.onOpenFile).not.toHaveBeenCalled();
    useWorkspaceFileSearch.mockReturnValue({
      data: { files: [file("old.ts")] },
      isPlaceholderData: true,
      isFetching: true,
    });
    settle();
    rerender(
      <CommandPalette
        {...props}
        fileTarget={{ workspace: { ...workspace, id: "workspace-b" }, folder: "/second" }}
      />,
    );
    expect(screen.queryByText("old.ts")).toBeNull();
    useWorkspaceFileSearch.mockReturnValue({ data: { files: [file("new.ts")] } });
    rerender(
      <CommandPalette
        {...props}
        fileTarget={{ workspace: { ...workspace, id: "workspace-b" }, folder: "/second" }}
      />,
    );
    fireEvent.click(labelRow("new.ts"));
    expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith("new.ts", {
      workspace: { ...workspace, id: "workspace-b" },
      folder: "/second",
    });
  });

  it("opens advanced search with the authoritative typed query without executing while typing", () => {
    const onFileSearch = vi.fn(),
      onOpenFile = vi.fn();
    const target = { workspace, folder: "/project" };
    renderPalette({ fileTarget: target, onFileSearch, onOpenFile });
    type("old");
    settle();
    type("current **query**");
    expect(onFileSearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Search file contents…"));
    expect(onFileSearch).toHaveBeenCalledExactlyOnceWith("current **query**", target);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("exposes truncation, errors and explicit retry without claiming complete results", () => {
    const refetch = vi.fn();
    useWorkspaceFileSearch.mockReturnValue({ data: { files: [], truncated: true }, refetch });
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      onToggleLeftSidebar: vi.fn(),
      onToggleRightSidebar: vi.fn(),
      fileTarget: { workspace },
      onOpenFile: vi.fn(),
    };
    const { rerender } = render(<CommandPalette {...props} />);
    type("rare");
    settle();
    expect(screen.getByText(/File results are limited/)).toBeTruthy();
    expect(screen.queryByText("No results found")).toBeNull();
    useWorkspaceFileSearch.mockReturnValue({ isError: true, refetch });
    rerender(<CommandPalette {...props} />);
    expect(refetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Retry file search"));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("retains supplied view actions and message-search callbacks alongside the inventory", () => {
    const run = vi.fn(),
      onMessageSearch = vi.fn(),
      onOpenProjects = vi.fn();
    const action = {
      id: "captured-view",
      label: "Captured view action",
      icon: SearchIcon,
      keywords: ["captured"],
      run,
    };
    setMessageResults([messageHit("source", "Notes", "match snippet")]);
    serverInfo.mockReturnValue({
      ...FALLBACK_SERVER_INFO,
      session_search_scope: true,
      login_url: "/login",
      enabled_connections: ["github"],
      features: { custom_agents_settings_ui: true },
      agent_install: true,
    });
    renderPalette({ actions: [action], onMessageSearch, onOpenProjects });
    for (const label of [
      "Settings: Appearance",
      "Settings: Custom agents",
      "Settings: Sandbox Integrations",
      "Settings: Account",
      "Go to Automations",
      "Open Projects",
    ])
      expect(screen.getByText(label)).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    expect(onOpenProjects).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Captured view action"));
    expect(run).toHaveBeenCalledOnce();
    type("match");
    settle();
    fireEvent.click(labelRow("Notes"));
    expect(onMessageSearch).toHaveBeenCalledExactlyOnceWith(
      "source",
      "match",
      expect.objectContaining({ itemId: "item-source", range: { start: 0, end: 5 } }),
      "all",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([{ open: false }, { sessionsOnly: true }])(
    "disables filename requests outside the global open palette: %o",
    (override) => {
      const props = {
        open: true,
        onOpenChange: vi.fn(),
        onToggleLeftSidebar: vi.fn(),
        onToggleRightSidebar: vi.fn(),
        fileTarget: { workspace },
        onOpenFile: vi.fn(),
      };
      const { rerender } = render(<CommandPalette {...props} />);
      type("file");
      settle();
      rerender(<CommandPalette {...props} {...override} />);
      expect(useWorkspaceFileSearch.mock.lastCall?.[4].enabled).toBe(false);
    },
  );
});

it("does not activate a message result from the previous query", () => {
  vi.useFakeTimers();
  try {
    const onMessageSearch = vi.fn();
    setMessageResults([messageHit("old-chat", "Old match", "older-query")]);
    renderPalette({ onMessageSearch });
    fireEvent.change(screen.getByTestId("command-palette-input"), {
      target: { value: "older-query" },
    });
    act(() => vi.advanceTimersByTime(300));
    expect(labelRow("Old match")).toBeTruthy();
    fireEvent.change(screen.getByTestId("command-palette-input"), {
      target: { value: "authoritative-new-query" },
    });
    expect(screen.queryByText("Old match")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("command-palette-input"), { key: "Enter" });
    expect(onMessageSearch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

describe("CommandPalette — Escape ownership", () => {
  function PaletteWithComposer({ tooltip, onClose }: { tooltip: boolean; onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <textarea aria-label="Composer draft" defaultValue="Keep this unsent draft" />
        <button type="button" onClick={() => setOpen(true)}>
          Open palette
        </button>
        <CommandPalette
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) onClose();
          }}
          onToggleLeftSidebar={vi.fn()}
          onToggleRightSidebar={vi.fn()}
        />
        <TooltipPrimitive.Provider>
          <TooltipPrimitive.Root open={tooltip}>
            <TooltipPrimitive.Trigger>Underlying composer control</TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
              <TooltipPrimitive.Content>Composer control tooltip</TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
          </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
      </>
    );
  }

  it.each([false, true])(
    "closes the real dialog from its input without leaking Escape (tooltip above: %s)",
    (tooltip) => {
      const onClose = vi.fn();
      const backgroundEscape = vi.fn((event: KeyboardEvent) => {
        if (event.key === "Escape") navigate("background-chat-shortcut");
      });
      const props = { tooltip: false, onClose };
      const { rerender } = render(<PaletteWithComposer {...props} />);
      fireEvent.focus(screen.getByLabelText("Composer draft"));
      fireEvent.click(screen.getByText("Open palette"));
      const input = screen.getByTestId("command-palette-input");
      fireEvent.change(input, { target: { value: "Activity" } });
      // A tooltip opening after the dialog becomes Radix's highest dismissal layer.
      rerender(<PaletteWithComposer {...props} tooltip={tooltip} />);
      if (tooltip) expect(screen.getByText("Composer control tooltip")).toBeTruthy();
      fireEvent.keyDown(input, { key: "Escape", code: "Escape", isComposing: true });
      expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      document.addEventListener("keydown", backgroundEscape);
      try {
        fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
        expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
        expect(onClose).toHaveBeenCalledOnce();
        expect(backgroundEscape).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(screen.getByLabelText("Composer draft")).toHaveValue("Keep this unsent draft");
      } finally {
        document.removeEventListener("keydown", backgroundEscape);
      }
    },
  );
});

it.each(["loading", {}] as const)(
  "sessions-only title lookup does not depend on grouped-search capabilities: %o",
  (info) => {
    vi.useFakeTimers();
    try {
      serverInfo.mockReturnValue(info);
      const fetchRecent = vi.fn(),
        fetchTitles = vi.fn();
      useConversations.mockReturnValue({
        data: { pages: [{ data: [conv("parent", "Recent parent")] }] },
        hasNextPage: true,
        fetchNextPage: fetchRecent,
      });
      setSearchGroups({
        title: {
          ...searchPages([conv("child", "Delegate target")]),
          hasNextPage: true,
          fetchNextPage: fetchTitles,
        },
        content: { isError: true },
      });
      renderPalette({ sessionsOnly: true });
      fetchRecent.mockClear();
      fireEvent.change(screen.getByTestId("command-palette-input"), {
        target: { value: "Delegate" },
      });
      act(() => vi.advanceTimersByTime(300));
      expect(useSessionSearch).toHaveBeenCalledWith("Delegate", "title", SEARCH_GROUP_OPTIONS);
      expect(fetchRecent).not.toHaveBeenCalled();
      expect(screen.queryByText("Couldn't load sessions.")).toBeNull();
      fireEvent.click(screen.getByText("Show more"));
      expect(fetchTitles).toHaveBeenCalledOnce();
      expect(fetchRecent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  },
);
