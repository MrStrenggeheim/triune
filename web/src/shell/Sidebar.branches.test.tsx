// Modified for Triune.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarDataProvider } from "@/hooks/useSidebarData";
import { WorkbenchProvider } from "@/workbench/WorkbenchContext";
import { conversation, conversationPage } from "@/test/sidebarMockHelpers";
import type * as IdentityModule from "@/lib/identity";
import type { BranchConversation } from "@/lib/conversationBranches";
import { authenticatedFetch } from "@/lib/identity";
import { useConversations } from "@/hooks/useConversations";
import { Sidebar } from "./Sidebar";
import { SIDEBAR_CONVERSATION_DRAG_MIME } from "./sidebarConversationDrag";
import { clearSessionDrafts, setSessionDraft } from "@/lib/sessionDrafts";
import { markConversationUnread, resetReadStateForTests } from "@/hooks/useUnseenConversations";
import { readEffectiveBindings, writeKeybindingOverrides } from "@/lib/keybindingPreferences";
import { resourceViewStorageScope, writeResourceViewState } from "@/lib/resourceViewStorage";

const actions = vi.hoisted(() => ({
  open: vi.fn(),
  move: vi.fn(),
  reorder: vi.fn(),
  pin: vi.fn(() => Promise.resolve({})),
  projects: [] as { id: string; name: string; archived?: boolean }[],
  pinned: [] as ReturnType<typeof conversation>[],
}));

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));
vi.mock("@/hooks/useConversations", async () => {
  const { conversationHooksMock } = await import("@/test/sidebarMockHelpers");
  return {
    ...conversationHooksMock(),
    useProjects: () => ({ data: actions.projects }),
    useMoveToProject: () => ({ mutate: actions.move }),
    useReorderPinnedConversations: () => ({ mutate: actions.reorder }),
    useTogglePinnedConversation: () => ({ mutateAsync: actions.pin }),
    usePinnedConversations: () => ({
      data: { conversations: actions.pinned, filterHonored: true },
      isSuccess: true,
    }),
  };
});
vi.mock("@/components/PermissionsModal", () => ({ PermissionsModal: () => null }));
vi.mock("@/lib/identity", async (original) => ({
  ...(await original<typeof IdentityModule>()),
  authenticatedFetch: vi.fn(),
}));
const branch = (id: string, parent?: string): BranchConversation => ({
  ...conversation(id),
  branch: parent
    ? { source_conversation_id: parent, reference_only: true, recovery: "replay" }
    : null,
});
const rows = [
  branch("root"),
  branch("one", "root"),
  branch("two", "one"),
  branch("three", "two"),
  branch("four", "three"),
];
beforeEach(() => {
  localStorage.clear();
  writeResourceViewState(
    `state:${JSON.stringify([resourceViewStorageScope(), "conversation-tree", "sidebar", "expanded"])}`,
    undefined,
  );
  clearSessionDrafts();
  resetReadStateForTests();
  actions.projects = [];
  actions.pinned = [];
  vi.mocked(useConversations).mockReturnValue(conversationPage([rows[0]]));
  vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
    const parsed = new URL(String(url), "http://test");
    if (parsed.pathname === "/v1/sessions") {
      expect(parsed.searchParams.get("include_side_chats")).toBe("true");
      expect(parsed.searchParams.get("kind")).toBe("any");
      return new Response(JSON.stringify({ data: rows, has_more: false, last_id: "four" }));
    }
    const row = rows.find((item) => parsed.pathname === `/v1/sessions/${item.id}`);
    if (row) return new Response(JSON.stringify(row));
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  cleanup();
  vi.clearAllMocks();
});
function renderTree(initial = "root", owner?: string | null, onOpenSearch?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [focusedConversationId, setFocused] = useState(initial);
    const [layoutOwnerConversationId, setOwner] = useState(owner);
    const navigation = {
      focusedConversationId,
      layoutOwnerConversationId,
      openConversationIds: ["root", "two"],
      openConversation: (
        id: string,
        options?: { beside?: boolean; mode?: "layout" | "tab" | "beside" },
      ) => {
        actions.open(id, options);
        if (!options?.beside) {
          setFocused(id);
          if (owner !== undefined && options?.mode !== "tab") setOwner(id);
        }
      },
      openView: vi.fn(),
    };
    return (
      <WorkbenchProvider value={navigation}>
        <Sidebar workbench open onClose={vi.fn()} onOpenSearch={onOpenSearch} />
      </WorkbenchProvider>
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <SidebarDataProvider>
        <TooltipProvider>
          <MemoryRouter>
            <Harness />
          </MemoryRouter>
        </TooltipProvider>
      </SidebarDataProvider>
    </QueryClientProvider>,
  );
}
it("coordinates a conversation hold with its drag sensor and never navigates on release", async () => {
  renderTree();
  const row = await screen.findByRole("link", { name: "root" });
  vi.useFakeTimers();
  try {
    const touch = { identifier: 1, target: row, clientX: 20, clientY: 20 };
    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.touchStart(row, { touches: [touch], changedTouches: [touch] });
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelector("[data-sidebar-drag-overlay]")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("menuitem", { name: "Open to side" })).toBeInTheDocument();
    fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 1 });
    fireEvent.touchEnd(row, { touches: [], changedTouches: [touch] });
    fireEvent.click(row);
    expect(actions.open).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  } finally {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
});

it("preserves the running spinner on a chat open elsewhere", async () => {
  vi.mocked(useConversations).mockReturnValue(
    conversationPage([{ ...rows[0], status: "running" }]),
  );
  renderTree("two");
  const spinner = await screen.findByRole("img", { name: "Session running" });
  expect(spinner.querySelector("svg")).not.toBeNull();
  expect(spinner.closest("[data-sidebar-session-id]")).toHaveAttribute(
    "data-open-elsewhere",
    "true",
  );
  expect(screen.queryByLabelText("Open elsewhere")).toBeNull();
});

it("uses trailing parent-only count/disclosure without reserving a leading root gutter", async () => {
  renderTree();
  const expand = await screen.findByRole("button", { name: "Expand subchats of root" });
  const root = screen.getByRole("link", { name: "root" }).closest("li")!;
  expect(expand).toHaveTextContent("4");
  expect(expand).toHaveClass(
    "cursor-pointer",
    "[@media((hover:hover)_and_(pointer:fine))]:group-data-[input=mouse]/sidebar:hover:bg-[color-mix(in_srgb,var(--foreground)_6%,var(--workspace-hover-on-chrome))]",
  );
  expect(
    expand.compareDocumentPosition(within(root).getByTestId("conversation-actions")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(root.style.getPropertyValue("--sidebar-row-inset")).toBe("0px");
  expect(screen.queryByText("Conversations")).toBeNull();
  expect(document.querySelector(".sidebar-header-row")).toBeNull();
  expect(screen.getByTestId("new-chat-button")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
  fireEvent.click(expand);
  const child = await screen.findByRole("link", { name: "one" });
  expect(child.closest("li")!.style.marginInlineStart).toBe("var(--sidebar-row-inset)");
  expect(child.closest("li")!.style.getPropertyValue("--sidebar-row-inset")).toBe(
    "calc(var(--list-row-padding-inline) + 8px + var(--list-row-gap) + 0 * var(--sidebar-tree-indent, 10px))",
  );
  expect(screen.queryByRole("link", { name: "two" })).toBeNull();
  expect(screen.getByRole("button", { name: "Expand subchats of one" })).toHaveTextContent("3");
  const guide = child.closest("li")!.querySelector("[data-sidebar-tree-guide]")!;
  expect(guide).toHaveClass("w-px", "bg-muted-foreground/50", "pointer-events-none");
  expect(guide.className).not.toMatch(/opacity-0/);
  expect((guide as HTMLElement).style.insetInlineStart).toBe(
    "calc(var(--list-row-padding-inline) + 8px + 0 * var(--sidebar-tree-indent, 10px) - var(--sidebar-row-inset, 0px))",
  );
  for (const id of ["one", "two", "three"]) {
    // oxlint-disable-next-line no-await-in-loop
    fireEvent.click(await screen.findByRole("button", { name: `Expand subchats of ${id}` }));
  }
  const leaf = await screen.findByRole("link", { name: "four" });
  expect(leaf.closest("li")!.querySelectorAll("[data-sidebar-tree-guide]")).toHaveLength(4);
  expect(within(leaf.closest("li")!).queryByRole("button", { name: /subchats/ })).toBeNull();
});

it.each([
  { status: "idle" as const, pending: 0, marker: "New messages" },
  { status: "running" as const, pending: 0, marker: "Session running" },
  { status: "idle" as const, pending: 2, marker: "2 approval prompts waiting" },
])(
  "retains the draft and $marker markers alongside open row actions",
  async ({ status, pending, marker }) => {
    vi.mocked(useConversations).mockReturnValue(
      conversationPage([{ ...rows[0], status, pending_elicitations_count: pending }]),
    );
    setSessionDraft("root", { text: "unfinished", files: [] });
    markConversationUnread("root", rows[0].updated_at);
    renderTree("two");
    const row = (await screen.findByRole("link", { name: /root/ })).closest("li")!;
    const indicators = within(row).getByTestId("conversation-indicators");
    expect(row).toHaveClass("gap-[var(--list-gap)]", "min-w-0");
    expect(within(row).getByRole("link")).toHaveClass("min-w-0", "flex-1");
    expect(within(row).getByRole("img", { name: marker })).toBeInTheDocument();
    const trigger = within(row).getByRole("button", { name: "Conversation actions" });
    expect(trigger).toHaveAccessibleDescription(expect.stringContaining("Draft"));
    expect(trigger).toHaveAccessibleDescription(expect.stringContaining("New messages"));
    expect(trigger).toContainElement(indicators);
    fireEvent.pointerDown(trigger, { button: 0 });
    expect(screen.getByRole("menuitem", { name: "Open to side" })).toBeInTheDocument();
    expect(row).toHaveAttribute("data-menu-open", "true");
    expect(trigger).toHaveAccessibleDescription(expect.stringContaining("Draft"));
    expect(indicators.className).toContain("group-data-[menu-open]/conversation:opacity-0");
  },
);

it.each(["menu", "context"])(
  "opens beside exactly once through the %s without ordinary navigation",
  async (entry) => {
    renderTree();
    const link = await screen.findByRole("link", { name: "root" });
    if (entry === "menu") {
      fireEvent.keyDown(
        within(link.closest("li")!).getByRole("button", { name: "Conversation actions" }),
        { key: "Enter" },
      );
    } else {
      fireEvent.contextMenu(link);
    }
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open to side" }));
    expect(actions.open).toHaveBeenCalledExactlyOnceWith("root", { beside: true });
  },
);

function nativeTransfer() {
  const data = new Map<string, string>();
  return {
    types: [SIDEBAR_CONVERSATION_DRAG_MIME],
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "uninitialized",
    dropEffect: "none",
  };
}

it("exports the native docking payload and suppresses the drag's trailing click", async () => {
  renderTree();
  const link = await screen.findByRole("link", { name: "root" });
  const transfer = nativeTransfer();
  fireEvent.mouseDown(link, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.mouseMove(document, { clientX: 30, clientY: 40 });
  expect(document.body.querySelector('[class*="max-w-[16rem]"]')).toBeNull();
  expect(fireEvent.dragStart(link, { dataTransfer: transfer })).toBe(true);
  expect(JSON.parse(transfer.getData(SIDEBAR_CONVERSATION_DRAG_MIME))).toEqual({
    id: "root",
    title: "root",
  });
  expect(transfer.effectAllowed).toBe("copyMove");
  fireEvent.dragEnd(link, { dataTransfer: transfer });
  fireEvent.click(link);
  expect(actions.open).not.toHaveBeenCalled();
  fireEvent.pointerDown(link);
  fireEvent.click(link);
  expect(actions.open).toHaveBeenCalledExactlyOnceWith("root", undefined);
});

it("keeps native project drops on the existing move path and clears canceled drags", async () => {
  actions.projects = [{ id: "alpha", name: "Alpha" }];
  renderTree();
  const link = await screen.findByRole("link", { name: "root" });
  const transfer = nativeTransfer();
  const folder = screen.getByRole("button", { name: "Alpha" });
  fireEvent.dragStart(link, { dataTransfer: transfer });
  expect(fireEvent.dragOver(folder, { dataTransfer: transfer })).toBe(false);
  fireEvent.drop(folder, { dataTransfer: transfer });
  expect(actions.move).toHaveBeenCalledExactlyOnceWith({ id: "root", project: "Alpha" });
  expect(actions.open).not.toHaveBeenCalled();
  actions.move.mockClear();
  fireEvent.dragStart(link, { dataTransfer: transfer });
  fireEvent.dragEnd(link, { dataTransfer: transfer });
  fireEvent.drop(folder, { dataTransfer: transfer });
  expect(actions.move).not.toHaveBeenCalled();
});

it("keeps native pinned-row reordering on the existing pin mutation path", async () => {
  actions.pinned = [
    conversation("pin-a", { labels: { "omnigent.pinned": "1000" } }),
    conversation("pin-b", { labels: { "omnigent.pinned": "2000" } }),
  ];
  renderTree();
  const source = await screen.findByRole("link", { name: "pin-a" });
  const target = await screen.findByRole("link", { name: "pin-b" });
  const transfer = nativeTransfer();
  fireEvent.dragStart(source, { dataTransfer: transfer });
  fireEvent.dragOver(target, { dataTransfer: transfer });
  expect(screen.getByTestId("pin-order-insertion")).toBeInTheDocument();
  fireEvent.drop(target, { dataTransfer: transfer });
  expect(actions.reorder).toHaveBeenCalledOnce();
  expect(actions.open).not.toHaveBeenCalled();
});
it("preloads hierarchy, expands four levels, and retains navigation, menus and expansion on remount", async () => {
  const mounted = renderTree();
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "root" })).toHaveAttribute("aria-current", "page"),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Expand subchats of root" })).toBeInTheDocument(),
  );
  expect(
    vi
      .mocked(authenticatedFetch)
      .mock.calls.filter(([url]) => String(url).startsWith("/v1/sessions?")),
  ).toHaveLength(1);
  for (const id of ["root", "one", "two", "three"]) {
    // Each expansion reveals the next branch.
    // oxlint-disable-next-line no-await-in-loop
    fireEvent.click(await screen.findByRole("button", { name: `Expand subchats of ${id}` }));
  }
  const leaf = await screen.findByRole("link", { name: "four" });
  expect(leaf).toHaveClass("density-row", "density-tree-row");
  fireEvent.click(leaf);
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "four" })).toHaveAttribute("aria-current", "page"),
  );
  expect(screen.getByRole("link", { name: /two/ })).not.toHaveAttribute("aria-current");
  expect(screen.queryByLabelText("Open elsewhere")).not.toBeInTheDocument();
  expect(document.querySelectorAll('[data-open-elsewhere="true"]')).toHaveLength(2);
  const row = leaf.closest("[data-sidebar-session-id]")!;
  fireEvent.contextMenu(within(row as HTMLElement).getByRole("link"));
  expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeInTheDocument();
  const inset = (row as HTMLElement).style.getPropertyValue("--sidebar-row-inset");
  fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
  const renameRow = screen.getByTestId("rename-conversation-input").closest("li")!;
  expect(renameRow.style.getPropertyValue("--sidebar-row-inset")).toBe(inset);
  expect(renameRow.querySelectorAll("[data-sidebar-tree-guide]")).toHaveLength(4);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  mounted.unmount();
  renderTree("four");
  expect(await screen.findByRole("link", { name: "four" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Collapse subchats of one" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(screen.getByRole("button", { name: "Collapse subchats of one" })).toHaveClass(
    "transition-none",
  );
});
it("never renders inaccessible ancestor titles and keeps an authorized orphan usable", async () => {
  const orphan = branch("authorized-orphan", "private-ancestor");
  vi.mocked(useConversations).mockReturnValue(conversationPage([orphan]));
  vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
    if (String(url).includes("private-ancestor"))
      return new Response(JSON.stringify({ title: "secret ancestor" }), { status: 403 });
    return new Response(JSON.stringify({ data: [], has_more: false }));
  });
  renderTree("authorized-orphan");
  await waitFor(() =>
    expect(authenticatedFetch).toHaveBeenCalledWith("/v1/sessions/private-ancestor"),
  );
  expect(screen.queryByText("secret ancestor")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "authorized-orphan" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.queryByText("private-ancestor")).not.toBeInTheDocument();
});

it("shows an unfiled child only beneath its project parent without moving membership", async () => {
  actions.projects = [{ id: "alpha", name: "Alpha" }];
  const parent = { ...rows[0], project_id: "alpha" };
  vi.mocked(useConversations).mockReturnValue(conversationPage([parent, ...rows.slice(1)]));
  renderTree();
  fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
  const expand = await screen.findByRole("button", { name: "Expand subchats of root" });
  expect(screen.queryByRole("link", { name: "one" })).toBeNull();
  fireEvent.click(expand);
  const child = await screen.findByRole("link", { name: "one" });
  expect(screen.getAllByRole("link", { name: "one" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Alpha" }).closest("section")).toContainElement(child);
  expect(rows[1].project_id).toBeUndefined();
  expect(actions.move).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
  expect(screen.queryByRole("link", { name: "one" })).toBeNull();
});

it.each(["pinned", "project"])(
  "retains explicit %s placement rather than nesting the child in another project",
  async (destination) => {
    actions.projects = [
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
    ];
    const child = {
      ...rows[1],
      ...(destination === "project"
        ? { project_id: "beta" }
        : { labels: { "omnigent.pinned": "1000" } }),
    };
    if (destination === "pinned") actions.pinned = [child];
    vi.mocked(useConversations).mockReturnValue(
      conversationPage([{ ...rows[0], project_id: "alpha" }, child, ...rows.slice(2)]),
    );
    renderTree();
    fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
    await screen.findByRole("link", { name: "root" });
    expect(screen.queryByRole("button", { name: "Expand subchats of root" })).toBeNull();
    if (destination === "project") fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    const expand = await screen.findByRole("button", { name: "Expand subchats of one" });
    expect(expand).toHaveTextContent("3");
    fireEvent.click(expand);
    expect(await screen.findByRole("link", { name: "two" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "one" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "two" })).toHaveLength(1);
    expect(actions.move).not.toHaveBeenCalled();
  },
);

it("keeps an unfiled child reachable when its parent's archived project is hidden", async () => {
  actions.projects = [{ id: "alpha", name: "Alpha", archived: true }];
  vi.mocked(useConversations).mockReturnValue(
    conversationPage([{ ...rows[0], project_id: "alpha" }, ...rows.slice(1)]),
  );
  renderTree();
  expect(await screen.findByRole("link", { name: "one" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
  expect(screen.queryByRole("link", { name: "root" })).toBeNull();
});

it("respects a hidden child project without hiding its individually unfiled descendants", async () => {
  actions.projects = [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta", archived: true },
  ];
  vi.mocked(useConversations).mockReturnValue(
    conversationPage([
      { ...rows[0], project_id: "alpha" },
      { ...rows[1], project_id: "beta" },
      ...rows.slice(2),
    ]),
  );
  renderTree();
  fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
  await screen.findByRole("link", { name: "root" });
  expect(screen.queryByRole("button", { name: "Expand subchats of root" })).toBeNull();
  expect(screen.queryByRole("link", { name: "one" })).toBeNull();
  expect(await screen.findByRole("link", { name: "two" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
});

it.each(["two", "native-child"])(
  "keeps the saved layout owner selected while %s is focused",
  async (focused) => {
    renderTree(focused, "root");
    const owner = await screen.findByRole("link", { name: "root" });
    expect(owner).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("link").filter((row) => row.hasAttribute("aria-current"))).toEqual([
      owner,
    ]);
  },
);

it("does not substitute the focused chat when the layout explicitly has no owner", async () => {
  renderTree("two", null);
  await screen.findByRole("link", { name: "root" });
  expect(
    screen.getAllByRole("link").filter((row) => row.hasAttribute("aria-current")),
  ).toHaveLength(0);
});

it("opens middle-clicked sessions as tabs while normal selection opens the chat layout", async () => {
  renderTree("two", "root");
  const root = await screen.findByRole("link", { name: "root" });
  fireEvent.mouseDown(root, { button: 1 });
  expect(actions.open).not.toHaveBeenCalled();
  fireEvent(root, new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
  expect(actions.open).toHaveBeenCalledExactlyOnceWith("root", { mode: "tab" });
  actions.open.mockClear();
  fireEvent.click(root);
  expect(actions.open).toHaveBeenCalledExactlyOnceWith("root", undefined);
});

it("places Search immediately after Inbox and reuses the provided global search callback", async () => {
  const openSearch = vi.fn();
  renderTree("root", undefined, openSearch);
  const search = await screen.findByRole("button", { name: "Search" });
  const inbox = screen.getByRole("link", { name: "Inbox" });
  expect(inbox.nextElementSibling).toBe(search);
  fireEvent.click(search);
  expect(openSearch).toHaveBeenCalledTimes(1);
  expect(search).toHaveClass("font-normal");
  expect(screen.getByRole("link", { name: "root" }).querySelector("span.relative")).toHaveClass(
    "font-normal",
  );
});

it("keeps ancestors collapsed when focusing a durable descendant", async () => {
  renderTree("four");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Expand subchats of root" })).toHaveTextContent("4"),
  );
  expect(screen.queryByRole("link", { name: "one" })).toBeNull();
});

it.each([
  { own: "idle" as const, descendant: true, expandedState: null },
  { own: "running" as const, descendant: true, expandedState: "running" },
  { own: "failed" as const, descendant: true, expandedState: "error" },
  { own: "idle" as const, descendant: null, expandedState: null },
])(
  "hides only descendant activity when children expand: own=$own, descendant=$descendant",
  async ({ own, descendant, expandedState }) => {
    vi.mocked(useConversations).mockReturnValue(
      conversationPage([
        {
          ...rows[0],
          status: descendant ? "running" : own,
          activity: { own_status: own, descendant_running: descendant },
        },
      ]),
    );
    renderTree("two");
    const row = (await screen.findByRole("link", { name: "root" })).closest("li")!;
    const before = within(row).queryByTestId("session-state-badge");
    if (own === "running" || (descendant && own === "idle"))
      expect(before).toHaveAttribute("data-state", "running");
    else if (own === "failed") expect(before).toHaveAttribute("data-state", "error");
    else expect(before).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Expand subchats of root" }));
    const after = within(row).queryByTestId("session-state-badge");
    if (expandedState) expect(after).toHaveAttribute("data-state", expandedState);
    else expect(after).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse subchats of root" }));
    if (own === "idle" && descendant)
      expect(within(row).getByTestId("session-state-badge")).toHaveAttribute(
        "data-state",
        "running",
      );
  },
);

it("keeps Search chips and ARIA synchronized with Find remapping and unbinding", async () => {
  renderTree("root", undefined, vi.fn());
  const search = await screen.findByRole("button", { name: "Search" });
  const binding = readEffectiveBindings().find((row) => row.command === "find")!;
  expect(search).toHaveAttribute("aria-keyshortcuts");
  act(() => {
    writeKeybindingOverrides({
      [binding.id]: {
        when: binding.when,
        stroke: { modifiers: ["Alt"] as const, match: { key: "j" } },
      },
    });
  });
  expect(search).toHaveAttribute("aria-keyshortcuts", "Alt+j");
  expect(search.querySelectorAll("kbd")).toHaveLength(2);
  expect(search).toHaveTextContent("J");
  act(() => {
    writeKeybindingOverrides({ [binding.id]: null });
  });
  const unbound = screen.getByRole("button", { name: "Search" });
  expect(unbound).not.toHaveAttribute("aria-keyshortcuts");
  expect(unbound.querySelector("kbd")).toBeNull();
});
