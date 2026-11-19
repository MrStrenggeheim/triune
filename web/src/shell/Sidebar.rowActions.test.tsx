// Modified for Triune.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));
import { SidebarDataProvider } from "@/hooks/useSidebarData";
// Conversation row menu, hover controls and pointer interactions.
import { useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ServerInfo } from "@/lib/capabilities";
import type * as IdentityModule from "@/lib/identity";
import { CapabilitiesProvider } from "@/lib/CapabilitiesContext";
import { clearSessionDrafts, setSessionDraft } from "@/lib/sessionDrafts";
import * as toastModule from "@/components/ui/toast";
import { USER_SESSION_TITLE_MAX_CHARS } from "@/lib/sessionTitles";
import { sessionActionRestrictions, type SessionActionSource } from "@/lib/sessionCapabilities";

vi.mock("@/hooks/useSessionActionRestrictions", () => ({
  useSessionActionRestrictions: (_id: string, source: SessionActionSource) =>
    sessionActionRestrictions(source),
}));

// Controllable rename mutation so the double-click test can assert the
// committed title was forwarded to the PATCH. `isMobile` toggles the mocked
// `useIsMobileViewport` so a test can render the row on a mobile viewport (the
// project flyout is disabled there). Declared via vi.hoisted so the vi.mock
// factories (hoisted above imports) can reference them.
const mocks = vi.hoisted(() => {
  // Tiny reactive store for the server-authoritative pinned set, so a quick-pin
  // click re-renders the sidebar (mirrors the real query's refetch). Holds ids;
  // the mocked hook maps them onto the loaded conversations.
  const pinnedListeners = new Set<() => void>();
  const pinnedStore = {
    ids: [] as string[],
    subscribe(cb: () => void) {
      pinnedListeners.add(cb);
      return () => pinnedListeners.delete(cb);
    },
    set(ids: string[]) {
      pinnedStore.ids = ids;
      pinnedListeners.forEach((cb) => cb());
    },
    toggle(id: string, pinned: boolean) {
      pinnedStore.set(
        pinned
          ? [id, ...pinnedStore.ids.filter((x) => x !== id)]
          : pinnedStore.ids.filter((x) => x !== id),
      );
    },
  };
  return {
    // `isSuccess`/`isError` drive the row's hold-the-committed-name logic:
    // it keeps showing the new title until the PATCH settles.
    rename: { mutate: vi.fn(), isSuccess: false, isError: false },
    isMobile: false,
    // Projects surfaced by the picker + the move-to-project mutation, so the
    // mobile in-place project view test can assert both the list and the pick.
    projects: [] as string[],
    projectIcons: {} as Record<string, string | null | undefined>,
    moveToProject: { mutate: vi.fn() },
    leave: { mutate: vi.fn(), isPending: false },
    // The signed-in viewer. Rows with no `owner` read as owned by them; a row
    // owned by someone else is the shared case Leave applies to.
    viewerId: "viewer@example.com" as string | null,
    conversations: [] as unknown[],
    pinnedStore,
  };
});

// Mock the mobile-viewport hook — jsdom doesn't evaluate media queries, so
// drive it explicitly. Defaults to desktop (false); the mobile flyout test
// flips `mocks.isMobile` for the duration of that case.
vi.mock("@/hooks/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mocks.isMobile,
}));

vi.mock("@/hooks/useConversations", async () => {
  const { conversationHooksMock } = await import("@/test/sidebarMockHelpers");
  return {
    ...conversationHooksMock(),
    usePinnedConversations: () => {
      const ids = useSyncExternalStore(mocks.pinnedStore.subscribe, () => mocks.pinnedStore.ids);
      const idSet = new Set(ids);
      return {
        data: {
          conversations: (mocks.conversations as { id: string }[]).filter((c) => idSet.has(c.id)),
          filterHonored: true,
        },
        isSuccess: true,
      };
    },
    useTogglePinnedConversation: () => ({
      mutate: ({ id, pinned }: { id: string; pinned: boolean }) =>
        mocks.pinnedStore.toggle(id, pinned),
      // Unpin goes through mutateAsync so the Undo pill waits for the write.
      mutateAsync: ({ id, pinned }: { id: string; pinned: boolean }) => {
        mocks.pinnedStore.toggle(id, pinned);
        return Promise.resolve({});
      },
    }),
    useRenameConversation: () => mocks.rename,
    useLeaveSession: () => mocks.leave,
    useProjects: () => ({
      data: mocks.projects.map((name: string) => ({
        id: `p_${name}`,
        name,
        icon: mocks.projectIcons[name],
      })),
    }),
    useProjectSessions: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    }),
    useMoveToProject: () => mocks.moveToProject,
  };
});

// Heavy sibling widgets pull their own hooks/providers; stub them so this
// test stays scoped to the conversation row.
vi.mock("./AgentTypeFilter", () => ({ AgentTypeFilter: () => null }));
vi.mock("./ReportIssueButton", () => ({ ReportIssueButton: () => null }));
vi.mock("@/components/PermissionsModal", () => ({ PermissionsModal: () => null }));
vi.mock("./ForkSessionDialog", () => ({
  ForkSessionDialog: ({ open, sourceSessionId }: { open: boolean; sourceSessionId: string }) =>
    open ? (
      <div data-testid="fork-session-dialog" data-source-session-id={sourceSessionId} />
    ) : null,
}));
// Force a multi-user (non-local) server so the "Shared with me" tab renders —
// jsdom's default loopback origin would otherwise read as single-user and hide
// the tabs the shared-session row actions rely on.
vi.mock("@/lib/serverOrigin", () => ({ isCurrentServerLocal: () => false }));
// Pin "who am I": ownership (and therefore Leave, which revokes the viewer's
// own grant) is derived from this id. Unmocked it resolves to null in jsdom,
// which reads as "not the owner" for shared rows but leaves Leave with no id
// to revoke.
vi.mock("@/lib/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityModule>()),
  getCurrentUserId: () => mocks.viewerId,
  resolveIdentity: () => Promise.resolve(mocks.viewerId),
}));

import { type Conversation, useConversations } from "@/hooks/useConversations";
import {
  markConversationUnread,
  resetReadStateForTests,
  seedReadState,
} from "@/hooks/useUnseenConversations";
import { Sidebar } from "./Sidebar";

const useConvMock = vi.mocked(useConversations);

const CONV: Conversation = {
  id: "conv_1",
  object: "conversation",
  title: "My Session",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  labels: {},
  permission_level: null,
  // owner absent → the viewer owns it (rename/share/pin all enabled)
  status: "idle",
};

function mockConversations(conversations: Conversation[]) {
  const dataResult = {
    data: {
      pages: [
        {
          data: conversations,
          first_id: conversations[0]?.id ?? null,
          last_id: conversations.at(-1)?.id ?? null,
          has_more: false,
        },
      ],
      pageParams: [undefined],
    },
    isLoading: false,
    isError: false,
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  } as unknown as ReturnType<typeof useConversations>;
  useConvMock.mockImplementation(() => dataResult);
  // The pinned mock maps its ids onto these loaded conversations.
  mocks.conversations = conversations;
}

/** Full ServerInfo with permissive defaults; override per test. */
function serverInfo(overrides: Partial<ServerInfo> = {}): ServerInfo {
  return {
    accounts_enabled: false,
    single_user: false,
    login_url: null,
    needs_setup: false,
    databricks_features: false,
    managed_sandboxes_enabled: false,
    sandbox_provider: null,
    enabled_connections: [],
    sharing_mode: "on",
    public_sharing_enabled: true,
    server_version: null,
    smart_routing_enabled: false,
    smart_routing_sources: { external: false, oss: false },
    features: {},
    harness_install_enabled: false,
    installable_harnesses: [],
    dictation_available: false,
    ...overrides,
  };
}

// `activeId` mounts the sidebar at `/c/:conversationId` (via a matching
// Route so `useParams` populates), making that row the active one — the
// rest of the suite renders at `/` where no row is active. `info` pins the
// server sharing policy via CapabilitiesProvider (default "loading" → on).
function renderSidebar(activeId?: string, info?: ServerInfo) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Build a FRESH element tree per render: re-rendering the identical element
  // reference lets React bail out without re-invoking the sidebar, which
  // would swallow a `mockConversations` swap applied mid-test.
  const makeUi = () => {
    const sidebar = <Sidebar open={true} onClose={vi.fn()} />;
    const tree = (
      <QueryClientProvider client={qc}>
        <SidebarDataProvider>
          <TooltipProvider>
            <MemoryRouter initialEntries={[activeId ? `/c/${activeId}` : "/"]}>
              {activeId ? (
                <Routes>
                  <Route path="/c/:conversationId" element={sidebar} />
                </Routes>
              ) : (
                sidebar
              )}
            </MemoryRouter>
          </TooltipProvider>
        </SidebarDataProvider>
      </QueryClientProvider>
    );
    // No explicit info → CapabilitiesContext default ("loading"), matching
    // every pre-existing test (sharing treated as on).
    return info ? <CapabilitiesProvider info={info}>{tree}</CapabilitiesProvider> : tree;
  };
  const view = render(makeUi());
  // Re-render so a test can apply a new `mockConversations` list mid-flight
  // (e.g. simulating a reorder pushed between user clicks).
  return Object.assign(view, { rerenderSidebar: () => view.rerender(makeUi()) });
}

beforeEach(() => {
  mocks.rename.mutate.mockReset();
  mocks.rename.isSuccess = false;
  mocks.rename.isError = false;
  mocks.moveToProject.mutate.mockReset();
  mocks.leave.mutate.mockReset();
  mocks.projects = [];
  mocks.projectIcons = {};
  // Default every test to the desktop viewport; the mobile flyout test opts in.
  mocks.isMobile = false;
  useConvMock.mockReset();
  localStorage.clear();
  clearSessionDrafts();
  // Reset the server pinned set between tests.
  mocks.pinnedStore.set([]);
  // The read-state mirror is module-level (in-memory), so reset it between
  // tests to avoid a mark-unread leaking into later rows.
  resetReadStateForTests();
  mockConversations([CONV]);
});

afterEach(cleanup);

describe("conversation actions and pin menu", () => {
  it("keeps a fixed rightmost action target and paints selection across the row", () => {
    renderSidebar("conv_1");
    const kebab = screen.getByTestId("conversation-actions");
    expect(kebab).toHaveClass("size-6", "shrink-0", "[@media(pointer:coarse)]:size-11");
    expect(kebab).not.toHaveClass("absolute");
    expect(kebab.parentElement).toHaveClass("shrink-0", "flex", "items-center");
    expect(kebab.parentElement!.lastElementChild).toBe(kebab);
    expect(screen.queryByTestId("quick-pin-conversation")).not.toBeInTheDocument();
    const rowLink = screen.getByRole("link", { name: "My Session" });
    expect(rowLink).toHaveClass("w-full", "min-w-0", "flex-1");
    expect(rowLink.closest("li")).toHaveClass("bg-[var(--sidebar-active)]");
    expect(rowLink).not.toHaveClass("bg-[var(--sidebar-active)]");
  });

  it("holds the action group width while the kebab menu is open", () => {
    renderSidebar();

    const rowLink = screen.getByRole("link", { name: "My Session" });
    expect(rowLink).not.toHaveClass("md:pr-20");

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });

    expect(rowLink.closest("li")).toHaveAttribute("data-menu-open", "true");
  });

  it("sizes the project-folder header controls to match the session-row kebab", () => {
    // Project and session menu buttons share the same compact right-edge slot.
    mocks.projects = ["Sprint 42"];
    renderSidebar();

    const projectActions = screen.getByTestId("project-actions");
    expect(projectActions).toHaveClass("size-6", "text-muted-foreground", "hover:text-foreground");
    expect(projectActions).not.toHaveClass("size-7");
    expect(projectActions.querySelector("svg")).toHaveClass("size-3.5");
    expect(projectActions.querySelector("svg")).toHaveAttribute("data-icon-size", "14");
    // Same compact size as the session-row kebab it aligns with.
    expect(screen.getByTestId("conversation-actions")).toHaveClass("size-6");
  });

  it("sizes the Projects group-header controls to the same compact icon", () => {
    // The "New project" button and the list-actions kebab (expand-all /
    // select-sessions live inside it) share the right-edge column with the
    // folder + session kebabs, so they use the same compact `icon-xs`
    // (size-6), not the larger `icon-sm` (size-7).
    mocks.projects = ["Sprint 42"];
    renderSidebar();

    for (const button of [
      screen.getByTestId("new-project"),
      screen.getByTestId("project-list-actions"),
    ]) {
      expect(button).toHaveClass("size-6", "text-muted-foreground", "hover:text-foreground");
      expect(button).not.toHaveClass("size-7");
    }
  });

  it("keeps the Projects group-header actions visible without hover, hover-revealed on desktop", () => {
    // The "New project" (+) button is the only way to create a project, so its
    // group-header wrapper must stay visible wherever hover is unavailable —
    // phones AND touch tablets at `md`+ widths — rather than fade out like the
    // desktop-only session-header controls. jsdom doesn't evaluate media
    // queries, so assert the responsive classes: base `flex` (shown at every
    // breakpoint) with the fade + hover/focus reveals gated on hover
    // capability, not just the `md` width.
    mocks.projects = ["Sprint 42"];
    renderSidebar();

    const wrapper = screen.getByTestId("new-project").closest(".transition-opacity");
    expect(wrapper).not.toBeNull();
    // Visible without hover: base display is `flex`, never `hidden`, and the
    // fade is not applied by viewport width alone.
    expect(wrapper).toHaveClass("flex");
    expect(wrapper).not.toHaveClass("hidden");
    expect(wrapper).not.toHaveClass("md:opacity-0");
    // Hover-capable desktop: fades out until the header is hovered / focused /
    // a menu opens.
    expect(wrapper).toHaveClass(
      "[@media((hover:hover)_and_(pointer:fine))]:md:group-[[data-input=mouse]:not(:hover):not(:has(:focus-visible)):not(:has([data-state=open]))]/header:opacity-0",
      "[@media((hover:hover)_and_(pointer:fine))]:md:group-[[data-input=mouse]:hover]/header:opacity-100",
      "[@media((hover:hover)_and_(pointer:fine))]:md:has-[:focus-visible]:opacity-100",
    );
  });

  it("hides the Projects list-actions kebab when there are no projects", () => {
    // With no projects, the kebab has nothing to offer (no expand/collapse, no
    // sessions to select) and would open empty — so it's hidden entirely,
    // leaving just the "New project" button.
    mocks.projects = [];
    renderSidebar();

    expect(screen.queryByTestId("project-list-actions")).toBeNull();
    expect(screen.getByTestId("new-project")).toBeInTheDocument();
  });

  it("pins and unpins through the same desktop menu and persistence", () => {
    renderSidebar();
    expect(screen.queryByText("Pinned")).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    const item = screen.getByTestId("pin-conversation");
    expect(item).not.toHaveClass("md:hidden");
    fireEvent.click(item);
    const section = screen.getByText("Pinned").closest("section")!;
    expect(within(section).getByText("My Session")).toBeInTheDocument();
    expect(mocks.pinnedStore.ids).toContain("conv_1");
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    expect(screen.getByTestId("pin-conversation")).toHaveTextContent("Unpin");
    fireEvent.click(screen.getByTestId("pin-conversation"));
    expect(screen.queryByText("Pinned")).toBeNull();
  });

  it.each([["quick-archive-conversation", "Archive"]])(
    "shows the %s action in a styled tooltip on hover",
    async (testId, label) => {
      const user = userEvent.setup();
      renderSidebar();

      await user.hover(screen.getByTestId(testId));
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent(label);
      expect(tooltip.querySelector("svg")).toBeNull();
    },
  );

  it("also offers Pin in the kebab menu (mobile affordance) and toggles the same pin state", () => {
    renderSidebar();

    expect(screen.queryByText("Pinned")).toBeNull();

    // Radix DropdownMenu opens on pointerdown, not click.
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });

    // The kebab carries a Pin item (mobile-only via `md:hidden`, but always in
    // the DOM since jsdom doesn't evaluate media queries). Clicking it drives
    // the same pin state as the quick button — the row moves under "Pinned".
    const pinItem = screen.getByTestId("pin-conversation");
    expect(pinItem).toHaveTextContent("Pin");
    fireEvent.click(pinItem);

    const pinnedHeader = screen.getByText("Pinned");
    const pinnedSection = pinnedHeader.closest("section")!;
    expect(within(pinnedSection).getByText("My Session")).toBeInTheDocument();
    expect(mocks.pinnedStore.ids).toContain("conv_1");
  });

  it.each([false, true])("exposes only the menu pin on mobile=%s", (mobile) => {
    mocks.isMobile = mobile;
    renderSidebar();
    expect(screen.queryByTestId("quick-pin-conversation")).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    expect(screen.getByTestId("pin-conversation")).not.toHaveClass("md:hidden");
  });

  it("gives the status and adjacent menu a complete accessible description", () => {
    mockConversations([{ ...CONV, pending_elicitations_count: 3 }]);
    renderSidebar();
    const trigger = screen.getByTestId("conversation-actions");
    expect(trigger).toHaveAccessibleDescription("3 approval prompts waiting");
    const badge = within(trigger.closest("li")!).getByTestId("session-state-badge");
    expect(badge).toHaveAttribute("aria-label", "3 approval prompts waiting");
    expect(badge).not.toHaveTextContent("Needs response");
    expect(badge).not.toHaveAttribute("data-slot", "tooltip-trigger");
    expect(trigger).toHaveClass("items-center", "justify-center");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "touch" });
    expect(screen.getByTestId("rename-conversation")).toBeInTheDocument();
  });

  it("keeps the row kebab reachable on touch with a desktop focus reveal", () => {
    // Touch needs the menu for Open to side and the existing session actions.
    renderSidebar();

    const kebab = screen.getByTestId("conversation-actions");
    expect(kebab).not.toHaveClass("hidden");
    const row = kebab.closest("li")!;
    expect(row.innerHTML).not.toContain("group-focus-within");
    expect(kebab).toHaveClass("focus-visible:ring-control-focus");
    expect(kebab).toHaveClass("sidebar-session-more");
    expect(screen.queryByTestId("conversation-indicators")).toBeNull();
    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1 });
    expect(row).toHaveAttribute("data-input", "touch");
    expect(screen.getByRole("complementary", { name: "Conversations" })).toHaveAttribute(
      "data-input",
      "touch",
    );
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    expect(row).toHaveAttribute("data-input", "mouse");
    kebab.focus();
    expect(kebab).toHaveFocus();
    expect(kebab).not.toHaveClass("md:block");
  });
});

describe("double-click to rename", () => {
  it("enters inline rename on double-click and commits the new title on Enter", () => {
    renderSidebar();

    // No edit field until the row is double-clicked.
    expect(screen.queryByTestId("rename-conversation-input")).toBeNull();

    const row = screen.getByRole("link", { name: /My Session/ });
    fireEvent.dblClick(row);

    const input = screen.getByTestId("rename-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed Session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The committed (trimmed) title is forwarded to the rename mutation with
    // the row's id — proving the double-click path drives the same rename as
    // the kebab's Rename item.
    expect(mocks.rename.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.rename.mutate).toHaveBeenCalledWith({ id: "conv_1", title: "Renamed Session" });
  });

  it("shows the committed title the moment the editor closes, before the list updates", () => {
    // The rename mutation writes the new name into the list cache, but that
    // reaches the row as a prop from the list above it, which re-renders a
    // tick after the row's own state change. The row must not fall back to
    // the pre-rename prop in between — that gap painted the old name for one
    // frame as the input disappeared. The mocked mutation never updates the
    // list, so the prop still says "My Session" throughout.
    renderSidebar();

    fireEvent.dblClick(screen.getByRole("link", { name: /My Session/ }));
    const input = screen.getByTestId("rename-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed Session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByTestId("rename-conversation-input")).toBeNull();
    expect(screen.getByRole("link", { name: /Renamed Session/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /My Session/ })).toBeNull();
  });

  it("drops the committed title once a failed rename rolls the cache back", () => {
    // The hook reverts the optimistic overlay when the PATCH fails, so the row
    // has to stop showing the name the server rejected.
    const { rerenderSidebar } = renderSidebar();

    fireEvent.dblClick(screen.getByRole("link", { name: /My Session/ }));
    const input = screen.getByTestId("rename-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed Session" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("link", { name: /Renamed Session/ })).toBeTruthy();

    mocks.rename.isError = true;
    rerenderSidebar();

    expect(screen.getByRole("link", { name: /My Session/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Renamed Session/ })).toBeNull();
  });

  it("does not commit the rename when Enter confirms an active IME composition", () => {
    renderSidebar();

    const row = screen.getByRole("link", { name: /My Session/ });
    fireEvent.dblClick(row);

    const input = screen.getByTestId("rename-conversation-input") as HTMLInputElement;
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "名前変更" } });

    // The Enter that confirms the conversion candidate must NOT commit.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.rename.mutate).not.toHaveBeenCalled();

    // Once composition ends, a subsequent Enter commits as usual.
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.rename.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.rename.mutate).toHaveBeenCalledWith({ id: "conv_1", title: "名前変更" });
  });

  it("does not commit the rename when Enter carries the IME keyCode 229 fallback", () => {
    renderSidebar();

    const row = screen.getByRole("link", { name: /My Session/ });
    fireEvent.dblClick(row);

    const input = screen.getByTestId("rename-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(mocks.rename.mutate).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.rename.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.rename.mutate).toHaveBeenCalledWith({ id: "conv_1", title: "Renamed" });
  });

  it("ignores a double-click whose first click landed on a different row", () => {
    // A native double-click delivers click, click, dblclick to one element.
    // If the list reorders between the two clicks (a session's updated_at
    // bump pushes rows around under the cursor), the second click and the
    // dblclick land on whichever row slid into place — which must NOT enter
    // rename, or the user renames a session they never aimed at.
    const convA: Conversation = {
      ...CONV,
      id: "conv_a",
      title: "Session A",
      updated_at: 1_700_000_200,
    };
    const convB: Conversation = {
      ...CONV,
      id: "conv_b",
      title: "Session B",
      updated_at: 1_700_000_100,
    };
    mockConversations([convA, convB]);
    const view = renderSidebar();

    // Click #1 of the user's double-click lands on session A (the top row).
    fireEvent.click(screen.getByRole("link", { name: /Session A/ }));

    // Before click #2, session B's updated_at bumps and the list reorders —
    // B now occupies the screen position where A was.
    mockConversations([{ ...convB, updated_at: 1_700_000_300 }, convA]);
    view.rerenderSidebar();

    // Click #2 and the dblclick land on B, the row now under the cursor.
    const rowB = screen.getByRole("link", { name: /Session B/ });
    fireEvent.click(rowB);
    fireEvent.dblClick(rowB);

    // B saw only the second click, so it must not enter rename.
    expect(screen.queryByTestId("rename-conversation-input")).toBeNull();
    expect(mocks.rename.mutate).not.toHaveBeenCalled();

    // A clean double-click on B — both clicks on the row — still renames it.
    fireEvent.click(rowB);
    fireEvent.click(rowB);
    fireEvent.dblClick(rowB);
    const input = screen.getByTestId("rename-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed B" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.rename.mutate).toHaveBeenCalledWith({ id: "conv_b", title: "Renamed B" });
  });

  it("does not enter rename on double-click for a viewer-only row", () => {
    // Rename is owner-only now, so a session owned by another user has its
    // kebab Rename item disabled and double-click must be inert too. A
    // non-owner session lives on the "Shared with me" tab, so switch to it
    // before reaching for the row.
    mockConversations([{ ...CONV, owner: "other@example.com" }]);
    renderSidebar();
    // Radix Tabs triggers activate on mousedown (primary button), not click.
    fireEvent.pointerDown(screen.getByTestId("session-filter"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByTestId("session-filter-shared"));

    fireEvent.dblClick(screen.getByRole("link", { name: /My Session/ }));

    expect(screen.queryByTestId("rename-conversation-input")).toBeNull();
    expect(mocks.rename.mutate).not.toHaveBeenCalled();
  });
});

describe("rename under the iOS soft keyboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Stub the iOS shell on an 844px layout. The returned function raises the
   * keyboard through UIKit's keyboard-viewport bridge or, for shells without
   * it, through WebKit's shrinking visualViewport.
   */
  function stubIOSShell(source: "native" | "visualViewport"): (visibleHeight: number) => void {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    let nativeViewport: { width: number; height: number } | null = null;
    const nativeListeners = new Set<() => void>();
    vi.stubGlobal("innerHeight", 844);
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("omnigentNative", {
      kind: "ios",
      ...(source === "native" && {
        getKeyboardViewport: () => nativeViewport,
        onKeyboardViewportChanged: (callback: () => void) => {
          nativeListeners.add(callback);
          return () => nativeListeners.delete(callback);
        },
      }),
    });
    return (visibleHeight) => {
      act(() => {
        if (source === "native") {
          nativeViewport = { width: window.innerWidth, height: visibleHeight };
          nativeListeners.forEach((callback) => callback());
        } else {
          viewport.height = visibleHeight;
          viewport.dispatchEvent(new Event("resize"));
        }
      });
    };
  }

  it.each(["native", "visualViewport"] as const)(
    "re-centers the focused rename field once the %s keyboard inset shrinks the list",
    (source) => {
      // The field focuses (raising the keyboard) while still visible; the
      // drawer's keyboard-inset padding then shrinks the list underneath it.
      const openKeyboard = stubIOSShell(source);
      renderSidebar();
      fireEvent.dblClick(screen.getByRole("link", { name: /My Session/ }));
      const input = screen.getByTestId("rename-conversation-input");
      expect(input).toHaveFocus();
      const scrollIntoView = vi.fn();
      input.scrollIntoView = scrollIntoView;

      openKeyboard(508);

      expect(screen.getByRole("complementary", { name: "Conversations" })).toHaveStyle({
        paddingBottom: "336px",
      });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    },
  );

  it("re-centers a rename field that opens while the keyboard is already up", () => {
    const openKeyboard = stubIOSShell("native");
    renderSidebar();
    openKeyboard(508);
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

    fireEvent.dblClick(screen.getByRole("link", { name: /My Session/ }));

    const input = screen.getByTestId("rename-conversation-input");
    expect(input).toHaveFocus();
    expect(scrollIntoView.mock.contexts).toContain(input);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });
});

describe("leave a shared session", () => {
  // Every other row action is owner-only, so "Leave session" is the one thing
  // a shared-with viewer can actually do: drop the session from their own
  // sidebar without touching the owner's copy.

  /** Switch to the "Shared with me" tab, where non-owned rows live. */
  function openSharedTab() {
    // Radix Tabs triggers activate on mousedown (primary button), not click.
    fireEvent.pointerDown(screen.getByTestId("session-filter"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByTestId("session-filter-shared"));
  }

  it("offers Leave on a shared row and calls the mutation after confirming", () => {
    mockConversations([{ ...CONV, owner: "other@example.com" }]);
    renderSidebar();
    openSharedTab();

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));
    fireEvent.click(screen.getByTestId("leave-conversation"));

    // Destructive, and the row vanishes on success — so it confirms first.
    expect(mocks.leave.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-leave-conversation"));
    // Leaving revokes the VIEWER's own grant, so the mutation carries their id
    // — not the owner's. Sending the owner's id would be a revoke attempt the
    // server rejects for lack of manage access.
    expect(mocks.leave.mutate).toHaveBeenCalledWith(
      { id: "conv_1", viewerId: "viewer@example.com" },
      expect.anything(),
    );
  });

  it("shows Delete instead of Leave on a row the viewer owns", () => {
    // The owner grant is what keeps the session reachable — leaving would
    // orphan it, so the owner deletes instead. One slot, not two items.
    mockConversations([CONV]);
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));

    expect(screen.getByTestId("delete-conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("leave-conversation")).toBeNull();
  });

  it("replaces the once-dead disabled Delete rather than adding an item", () => {
    // The point of reusing the slot: a non-owner used to get Delete rendered
    // disabled ("only the owner can delete"), a row that could never do
    // anything. Leave takes that slot — so exactly ONE destructive item shows,
    // and it is never a disabled Delete.
    mockConversations([{ ...CONV, owner: "other@example.com" }]);
    renderSidebar();
    openSharedTab();

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));

    expect(screen.getByTestId("leave-conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("delete-conversation")).toBeNull();
  });

  it("keeps the plain owner Delete in single-user mode, where nothing is shared", () => {
    // Single-user mode has one identity and no sharing, so an unowned-looking
    // row must not offer Leave — it falls back to Delete.
    mockConversations([{ ...CONV, owner: "other@example.com" }]);
    renderSidebar(undefined, serverInfo({ single_user: true }));

    // The default filter is "My sessions", which scopes out this owner:other
    // row; the single-user menu still offers "All sessions", so switch to it to
    // surface the row this test is about.
    fireEvent.pointerDown(screen.getByTestId("session-filter"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByTestId("session-filter-all"));

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));

    expect(screen.queryByTestId("leave-conversation")).toBeNull();
    expect(screen.getByTestId("delete-conversation")).toBeInTheDocument();
  });
});

describe("quick-archive owner gate", () => {
  // Archive is owner-only: the kebab renders its Archive item disabled for
  // non-owners ("Only the session owner can archive this session"). The hover
  // quick button must enforce the same gate — so a non-owner never gets the
  // affordance the menu deliberately blocks.
  it("hides the quick-archive button on a shared row the viewer doesn't own", () => {
    mockConversations([{ ...CONV, owner: "other@example.com" }]);
    renderSidebar();
    // Non-owned rows live on the "Shared with me" tab (activates on mousedown).
    fireEvent.pointerDown(screen.getByTestId("session-filter"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByTestId("session-filter-shared"));

    expect(screen.getByRole("link", { name: /My Session/ })).toBeInTheDocument();
    expect(screen.queryByTestId("quick-archive-conversation")).toBeNull();

    // The kebab still carries the (disabled) Archive item — the gate hides only
    // the quick button, not the explanatory menu entry.
    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));
    expect(screen.getByTestId("archive-conversation")).toHaveAttribute("data-disabled");
  });

  it("shows the quick-archive button on a row the viewer owns", () => {
    mockConversations([CONV]);
    renderSidebar();

    expect(screen.getByTestId("quick-archive-conversation")).toBeInTheDocument();
  });
});

describe("pinned row project flyout", () => {
  it.each([
    {
      source: "project label with branch metadata",
      firstClass: false,
      icon: undefined,
      git_branch: "fix/sidebar-row-height",
    },
    { source: "first-class project with an emoji", firstClass: true, icon: "🚀" },
    { source: "project label without an emoji", firstClass: false, icon: undefined },
  ])(
    "keeps $source out of row hover and focus guidance",
    async ({ firstClass, icon, git_branch }) => {
      vi.useFakeTimers();
      try {
        if (firstClass) mocks.projects = ["Moonshot"];
        if (icon) mocks.projectIcons = { Moonshot: icon };
        mocks.pinnedStore.set(["conv_1"]);
        mockConversations([
          {
            ...CONV,
            ...(firstClass
              ? { project_id: "p_Moonshot" }
              : { labels: { omni_project: "Moonshot" } }),
            git_branch,
          },
        ]);
        renderSidebar();
        const pinned = screen.getByRole("button", { name: /^Pinned/ }).closest("section")!;
        const row = within(pinned).getByRole("link", { name: "My Session" });
        expect(row).toHaveAttribute("href", "/c/conv_1");
        expect(row).not.toHaveAttribute("title");
        expect(row).not.toHaveAttribute("data-slot", "hover-card-trigger");

        fireEvent.pointerEnter(row, { pointerType: "mouse" });
        fireEvent.mouseEnter(row);
        fireEvent.focus(row);
        await act(() => vi.advanceTimersByTimeAsync(1000));

        expect(screen.queryByTestId("pinned-project-flyout")).toBeNull();
        expect(screen.queryByTestId("session-tooltip-content")).toBeNull();
        expect(screen.queryByRole("tooltip")).toBeNull();
        expect(row.querySelector("[title]")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("renders no project flyout for a pinned row with no project", () => {
    // No project label → nothing to surface, so the row keeps its plain native
    // title tooltip and never mounts a hover-card trigger.
    mocks.pinnedStore.set(["conv_1"]);
    mockConversations([{ ...CONV, labels: {} }]);
    renderSidebar();
    expect(screen.getByText("Pinned")).toBeInTheDocument();

    const row = screen.getByRole("link", { name: /My Session/ });
    expect(row).not.toHaveAttribute("data-slot", "hover-card-trigger");
    fireEvent.focus(row);
    expect(screen.queryByTestId("pinned-project-flyout")).toBeNull();
  });

  it("keeps mobile pinned rows free of flyouts and native titles while preserving actions", async () => {
    vi.useFakeTimers();
    try {
      mocks.isMobile = true;
      mocks.pinnedStore.set(["conv_1"]);
      mockConversations([{ ...CONV, labels: { omni_project: "Moonshot" } }]);
      renderSidebar();
      const pinned = screen.getByRole("button", { name: /^Pinned/ }).closest("section")!;
      const row = within(pinned).getByRole("link", { name: "My Session" });
      expect(row).toHaveAttribute("href", "/c/conv_1");
      expect(row).not.toHaveAttribute("title");
      expect(row).not.toHaveAttribute("data-slot", "hover-card-trigger");

      fireEvent.pointerEnter(row, { pointerType: "mouse" });
      fireEvent.mouseEnter(row);
      fireEvent.focus(row);
      await act(() => vi.advanceTimersByTimeAsync(1000));

      expect(screen.queryByTestId("pinned-project-flyout")).toBeNull();
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(row.querySelector("[title]")).toBeNull();
      fireEvent.pointerDown(within(pinned).getByRole("button", { name: "Conversation actions" }), {
        button: 0,
      });
      expect(screen.getByTestId("rename-conversation")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mobile in-place project picker", () => {
  // Desktop opens the "Add to project" item as a side-flyout submenu, but a
  // side flyout has no room on mobile. There the item instead swaps the kebab
  // body in place: the main actions are replaced by the project picker (search
  // + list) plus a Back control that returns to the main menu — no submenu, no
  // close/reopen. Desktop keeps the flyout untouched.

  it("swaps the kebab body to the project picker in place, and Back returns", () => {
    mocks.isMobile = true;
    mocks.projects = ["Sprint 42"];
    renderSidebar();

    // Radix DropdownMenu opens on pointerdown, not click.
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });

    // Main view shows the everyday actions and the (unfiled) project entry.
    expect(screen.getByTestId("rename-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("delete-conversation")).toBeInTheDocument();
    const moveItem = screen.getByTestId("move-to-project");
    expect(moveItem).toHaveTextContent("Add to project");
    // It's a plain item on mobile, NOT a side-flyout submenu trigger.
    expect(moveItem).not.toHaveAttribute("aria-haspopup", "menu");

    // Tapping it swaps the body in place to the project picker — the main
    // actions are gone, and the picker (search + project list) plus a Back
    // control are shown.
    fireEvent.click(moveItem);
    expect(screen.getByPlaceholderText("Search or create project")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Sprint 42/ })).toBeInTheDocument();
    expect(screen.getByTestId("project-picker-back")).toBeInTheDocument();
    // The main actions are no longer rendered — the body was replaced, not
    // stacked beside a flyout.
    expect(screen.queryByTestId("rename-conversation")).toBeNull();
    expect(screen.queryByTestId("delete-conversation")).toBeNull();

    // Back returns to the main menu without closing it: the everyday actions
    // are visible again and the picker is gone.
    fireEvent.click(screen.getByTestId("project-picker-back"));
    expect(screen.getByTestId("rename-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("delete-conversation")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search or create project")).toBeNull();
  });

  it("moves the session into a picked project just like desktop", () => {
    mocks.isMobile = true;
    mocks.projects = ["Sprint 42"];
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    fireEvent.click(screen.getByTestId("move-to-project"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Sprint 42/ }));

    // Same mutation contract as the desktop submenu pick.
    expect(mocks.moveToProject.mutate).toHaveBeenCalledWith({
      id: "conv_1",
      project: "Sprint 42",
    });
  });

  it("creates a project from a typed name that matches nothing", () => {
    mocks.isMobile = true;
    mocks.projects = ["Sprint 42"];
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    fireEvent.click(screen.getByTestId("move-to-project"));

    fireEvent.change(screen.getByPlaceholderText("Search or create project"), {
      target: { value: "Roadmap" },
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Create Roadmap/ }));

    // The move resolves-or-creates the project id server-side, so filing into a
    // brand-new name uses the same mutation contract as picking an existing one.
    expect(mocks.moveToProject.mutate).toHaveBeenCalledWith({
      id: "conv_1",
      project: "Roadmap",
    });
  });

  it("offers no create row when the typed name already exists", () => {
    mocks.isMobile = true;
    mocks.projects = ["Sprint 42"];
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    fireEvent.click(screen.getByTestId("move-to-project"));

    fireEvent.change(screen.getByPlaceholderText("Search or create project"), {
      target: { value: "sprint 42" },
    });
    expect(screen.queryByRole("menuitem", { name: /Create/ })).toBeNull();
  });

  it("orders decorative project icons and a folder fallback before their names", () => {
    mocks.isMobile = true;
    mocks.projects = ["Sprint 42", "Legacy project"];
    mocks.projectIcons = { "Sprint 42": "🚀" };
    mockConversations([{ ...CONV, labels: { omni_project: "Sprint 42" } }]);
    mocks.pinnedStore.set([CONV.id]);
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    fireEvent.click(screen.getByTestId("move-to-project"));

    const iconRow = screen.getByRole("menuitem", { name: "Sprint 42" });
    const emoji = iconRow.firstElementChild;
    expect(emoji).toHaveAttribute("data-testid", "project-icon");
    expect(emoji).toHaveAttribute("aria-hidden", "true");
    expect(emoji).toHaveTextContent("🚀");
    expect(emoji?.nextElementSibling).toHaveTextContent("Sprint 42");

    const fallback = screen.getByRole("menuitem", { name: "Legacy project" }).firstElementChild;
    expect(fallback?.tagName.toLowerCase()).toBe("svg");
    expect(fallback).toHaveAttribute("aria-hidden", "true");
    expect(fallback?.nextElementSibling).toHaveTextContent("Legacy project");

    const removeItem = screen.getByRole("menuitem", { name: "Remove from Sprint 42" });
    expect(removeItem.firstElementChild).toHaveAttribute("data-testid", "project-icon");
    expect(removeItem.firstElementChild).toHaveTextContent("🚀");
  });

  it("uses project names and the Remove label for desktop picker typeahead", async () => {
    mocks.projects = ["Alpha", "Sprint 42"];
    mocks.projectIcons = { "Sprint 42": "🚀" };
    mockConversations([{ ...CONV, labels: { omni_project: "Sprint 42" } }]);
    mocks.pinnedStore.set([CONV.id]);
    const view = renderSidebar();

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    const moveTrigger = screen.getByTestId("move-to-project");
    moveTrigger.focus();
    fireEvent.keyDown(moveTrigger, { key: "ArrowRight" });

    const alphaRow = await screen.findByRole("menuitem", { name: "Alpha" });
    const sprintRow = screen.getByRole("menuitem", { name: "Sprint 42" });
    expect(alphaRow.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(alphaRow.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(alphaRow.firstElementChild?.nextElementSibling).toHaveTextContent("Alpha");
    expect(sprintRow.firstElementChild).toHaveAttribute("data-testid", "project-icon");
    expect(sprintRow.firstElementChild?.nextElementSibling).toHaveTextContent("Sprint 42");
    await waitFor(() => expect(alphaRow).toHaveFocus());
    fireEvent.keyDown(alphaRow, { key: "s" });
    await waitFor(() => expect(sprintRow).toHaveFocus());

    view.unmount();
    renderSidebar();
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    const freshMoveTrigger = screen.getByTestId("move-to-project");
    freshMoveTrigger.focus();
    fireEvent.keyDown(freshMoveTrigger, { key: "ArrowRight" });

    const freshAlphaRow = await screen.findByRole("menuitem", { name: "Alpha" });
    const removeItem = screen.getByRole("menuitem", { name: "Remove from Sprint 42" });
    await waitFor(() => expect(freshAlphaRow).toHaveFocus());
    fireEvent.keyDown(freshAlphaRow, { key: "r" });
    await waitFor(() => expect(removeItem).toHaveFocus());
  });

  it("keeps the desktop side-flyout submenu (no in-place swap)", () => {
    // Desktop viewport (default). The project entry is a submenu trigger, and
    // opening the kebab never renders the in-place Back control.
    mocks.projects = ["Sprint 42"];
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    const moveItem = screen.getByTestId("move-to-project");
    // Radix SubTrigger advertises a submenu popup.
    expect(moveItem).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByTestId("project-picker-back")).toBeNull();
  });
});

describe("mark as unread", () => {
  it("re-lights the row's unread dot via an explicit mark-unread", () => {
    renderSidebar();

    // The row starts seen (no baseline) — no unread marker.
    expect(screen.queryByText("(unread)")).toBeNull();

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    fireEvent.click(screen.getByTestId("mark-unread-conversation"));

    // The dot's accessible label appears immediately (in-tab tick on the
    // optimistic mirror write); the baseline is also synced to the server.
    expect(screen.getByText("(unread)")).toBeInTheDocument();
  });

  it("keeps an explicit unread dot alongside the running state", () => {
    mockConversations([{ ...CONV, status: "running" }]);
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    fireEvent.click(screen.getByTestId("mark-unread-conversation"));

    expect(screen.getByText("(unread)")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-actions")).toHaveAccessibleDescription(
      expect.stringContaining("New messages"),
    );
    expect(screen.getByRole("img", { name: "Session running" })).toBeInTheDocument();

    // Once the turn finishes (row re-renders as idle), the dot lights — the
    // baseline (kept in the in-memory mirror) now reads unseen for a
    // finished session.
    cleanup();
    mockConversations([{ ...CONV, status: "idle" }]);
    renderSidebar();
    expect(screen.getByText("(unread)")).toBeInTheDocument();
  });

  it("lights the dot on the active thread you're currently viewing", () => {
    // The active row normally suppresses the dot (you're reading it), but an
    // explicit mark-unread is a deliberate flag, so the dot must show.
    renderSidebar("conv_1");

    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    fireEvent.click(screen.getByTestId("mark-unread-conversation"));

    expect(screen.getByText("(unread)")).toBeInTheDocument();
  });

  it("is hidden once the row is already unread", () => {
    // Seed a baseline below updated_at (as the conversation list would) so
    // the row is already unseen.
    seedReadState([{ id: "conv_1", viewer_last_seen: CONV.updated_at - 1 }]);
    renderSidebar();

    expect(screen.getByText("(unread)")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    expect(screen.queryByTestId("mark-unread-conversation")).toBeNull();
  });
});

describe("right-click context menu", () => {
  it("keeps Fork visible but unavailable for a managed source", () => {
    mockConversations([{ ...CONV, labels: { "omnigent.host_type": "managed" } }]);
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));
    const fork = screen.getByRole("menuitem", { name: "Fork" });
    expect(fork).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(fork);
    fireEvent.keyDown(fork, { key: "Enter" });
    expect(screen.queryByTestId("fork-session-dialog")).not.toBeInTheDocument();
  });

  it("opens the fork dialog for the selected session", () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork" }));

    expect(screen.getByTestId("fork-session-dialog")).toHaveAttribute(
      "data-source-session-id",
      "conv_1",
    );
  });

  it.each(["quick-archive-conversation", "conversation-actions"])(
    "opens the session menu when right-clicking the %s button",
    (testId) => {
      renderSidebar();

      expect(fireEvent.contextMenu(screen.getByTestId(testId))).toBe(false);

      expect(screen.getByTestId("rename-conversation")).toBeInTheDocument();
    },
  );

  it("opens the same action items as the kebab and drives the same handlers", () => {
    renderSidebar();

    // Nothing in the DOM until the row is right-clicked (the kebab menu is
    // closed, so its items aren't rendered either).
    expect(screen.queryByTestId("rename-conversation")).toBeNull();

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));

    // The context menu carries the full set of kebab actions — same testids,
    // so it renders from the shared ConversationMenuItems body.
    expect(screen.getByTestId("share-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("rename-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("move-to-project")).toBeInTheDocument();
    expect(screen.getByTestId("archive-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("delete-conversation")).toBeInTheDocument();

    // Selecting Rename runs the same path as the kebab / double-click: the
    // inline rename input appears.
    fireEvent.click(screen.getByTestId("rename-conversation"));
    expect(screen.getByTestId("rename-conversation-input")).toBeInTheDocument();
  });

  it("holds the list order under the pointer so a right-click rename hits the aimed row", () => {
    // A right-click is a single event, so nothing can cross-check it like the
    // double-click guard does — if the list reorders in the instant before
    // the click lands, the row that slid under the cursor opens its (visually
    // identical) menu and gets renamed. The fix is upstream: while the
    // pointer is inside the list, every row's sort key is frozen so rows
    // can't move under the cursor at all.
    const convA: Conversation = {
      ...CONV,
      id: "conv_a",
      title: "Session A",
      updated_at: 1_700_000_200,
    };
    const convB: Conversation = {
      ...CONV,
      id: "conv_b",
      title: "Session B",
      updated_at: 1_700_000_100,
    };
    mockConversations([convA, convB]);
    const view = renderSidebar();

    // The pointer moves over the list, aiming at session A (the top row).
    fireEvent.mouseOver(screen.getByTestId("sidebar-conversation-list"));

    // Session B's updated_at bumps past A before the right-click lands.
    mockConversations([{ ...convB, updated_at: 1_700_000_300 }, convA]);
    view.rerenderSidebar();

    // The order holds: A is still the top row, exactly where the user aims.
    const links = screen.getAllByRole("link", { name: /^Session/ });
    expect(links[0]).toHaveAccessibleName(/Session A/);

    // Right-click the top row and rename it — the PATCH targets session A.
    fireEvent.contextMenu(links[0]);
    fireEvent.click(screen.getByTestId("rename-conversation"));
    const input = screen.getByTestId("rename-conversation-input") as HTMLInputElement;
    expect(input).toHaveAttribute("maxLength", String(USER_SESSION_TITLE_MAX_CHARS));
    fireEvent.change(input, { target: { value: "Renamed A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.rename.mutate).toHaveBeenCalledWith({ id: "conv_a", title: "Renamed A" });
  });

  it("keeps the order held while a rename edit is open even after the pointer leaves", () => {
    // The pointer naturally drifts out of the sidebar while typing a new
    // title. If that released the freeze, background updated_at churn would
    // shuffle rows around the open input — and moving the input's DOM node
    // blurs it, committing a half-typed title. An open rename edit must hold
    // the order on its own; the snap-back happens once the edit ends.
    const convA: Conversation = {
      ...CONV,
      id: "conv_a",
      title: "Session A",
      updated_at: 1_700_000_200,
    };
    const convB: Conversation = {
      ...CONV,
      id: "conv_b",
      title: "Session B",
      updated_at: 1_700_000_100,
    };
    mockConversations([convA, convB]);
    const view = renderSidebar();

    // Open the rename input on session A via right-click → Rename.
    fireEvent.mouseOver(screen.getByTestId("sidebar-conversation-list"));
    fireEvent.contextMenu(screen.getByRole("link", { name: /Session A/ }));
    fireEvent.click(screen.getByTestId("rename-conversation"));
    const input = screen.getByTestId("rename-conversation-input") as HTMLInputElement;

    // The pointer leaves the list mid-edit; then session B's updated_at bumps.
    fireEvent.mouseOut(screen.getByTestId("sidebar-conversation-list"), {
      relatedTarget: document.body,
    });
    mockConversations([{ ...convB, updated_at: 1_700_000_300 }, convA]);
    view.rerenderSidebar();

    // The edit row still holds the top slot (the edit input replaces A's link,
    // so B — below it — must still be the only link, not the first row).
    expect(screen.getByTestId("rename-conversation-input")).toBe(input);
    const listEl = screen.getByTestId("sidebar-conversation-list");
    const rowB = screen.getByRole("link", { name: /Session B/ });
    expect(input.compareDocumentPosition(rowB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listEl).toContainElement(rowB);

    // Committing the rename targets session A and releases the hold: the
    // order snaps to reality (B first).
    fireEvent.change(input, { target: { value: "Renamed A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.rename.mutate).toHaveBeenCalledWith({ id: "conv_a", title: "Renamed A" });
    const after = screen.getAllByRole("link", { name: /^Session/ });
    expect(after[0]).toHaveAccessibleName(/Session B/);
  });

  it("snaps the order back to reality when the pointer leaves the list", () => {
    const convA: Conversation = {
      ...CONV,
      id: "conv_a",
      title: "Session A",
      updated_at: 1_700_000_200,
    };
    const convB: Conversation = {
      ...CONV,
      id: "conv_b",
      title: "Session B",
      updated_at: 1_700_000_100,
    };
    mockConversations([convA, convB]);
    const view = renderSidebar();

    fireEvent.mouseOver(screen.getByTestId("sidebar-conversation-list"));
    mockConversations([{ ...convB, updated_at: 1_700_000_300 }, convA]);
    view.rerenderSidebar();
    expect(screen.getAllByRole("link", { name: /^Session/ })[0]).toHaveAccessibleName(/Session A/);

    fireEvent.mouseOut(screen.getByTestId("sidebar-conversation-list"), {
      relatedTarget: document.body,
    });
    expect(screen.getAllByRole("link", { name: /^Session/ })[0]).toHaveAccessibleName(/Session B/);
  });
});

describe("sharing kill switch", () => {
  it("disables the row's Share item for a manager when sharing_mode is off", () => {
    // CONV is owner-level (permission_level null → canManage), yet a server
    // reporting sharing_mode off must gray out Share for everyone.
    mockConversations([CONV]);
    renderSidebar(undefined, serverInfo({ sharing_mode: "off" }));

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));

    // Radix marks a disabled menu item with data-disabled; the enabled
    // (on / read_only) branch renders a plain selectable item without it.
    expect(screen.getByTestId("share-conversation")).toHaveAttribute("data-disabled");
  });

  it("keeps the row's Share item enabled for a manager when sharing is on", () => {
    mockConversations([CONV]);
    renderSidebar(undefined, serverInfo({ sharing_mode: "on" }));

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));

    expect(screen.getByTestId("share-conversation")).not.toHaveAttribute("data-disabled");
  });

  it("omits the row's Share item entirely in single-user mode", () => {
    // Explicit single_user marker: no other users to share with, so the item
    // is removed — not just disabled like the sharing-off case.
    // isCurrentServerLocal is mocked false, so this exercises the single-user
    // gate specifically (not the local-server path).
    mockConversations([CONV]);
    renderSidebar(undefined, serverInfo({ single_user: true }));

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));

    expect(screen.queryByTestId("share-conversation")).toBeNull();
    // Other row actions still render — only Share is gated on single-user.
    expect(screen.getByTestId("rename-conversation")).toBeInTheDocument();
  });

  it("keeps the row's Share item on a multi-user header-auth deploy (not single_user)", () => {
    // Header-auth multi-user (SSO proxy): accounts off AND no login_url, same
    // shape as single-user, but single_user false — the item must stay.
    mockConversations([CONV]);
    renderSidebar(undefined, serverInfo({ single_user: false }));

    fireEvent.contextMenu(screen.getByRole("link", { name: /My Session/ }));

    expect(screen.getByTestId("share-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("share-conversation")).not.toHaveAttribute("data-disabled");
  });
});

describe("peek mode row menu", () => {
  // Peek render variant: the menu content portals OUTSIDE the <aside>, so
  // moving the pointer from the kebab into the open menu fires the aside's
  // onPointerLeave. The grace-period close must hold while a menu is open.
  function renderPeek() {
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SidebarDataProvider>
          <TooltipProvider>
            <MemoryRouter>
              <Sidebar open={false} peek onClose={onClose} />
            </MemoryRouter>
          </TooltipProvider>
        </SidebarDataProvider>
      </QueryClientProvider>,
    );
    return { onClose };
  }

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("holds the peek open while a row's kebab menu is open", () => {
    const { onClose } = renderPeek();

    // Open the row's kebab (Radix opens on pointerdown) — its content portals
    // outside the aside, so the pointer entering it leaves the aside.
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    expect(screen.getByTestId("rename-conversation")).toBeInTheDocument();

    const aside = screen.getByRole("complementary", { name: "Conversations" });
    fireEvent.pointerLeave(aside);

    // Grace period elapses, but the open menu holds the peek — no close.
    vi.advanceTimersByTime(1000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes once the menu is gone and the pointer is away", () => {
    const { onClose } = renderPeek();

    const aside = screen.getByRole("complementary", { name: "Conversations" });
    // No menu open: a plain pointer-leave closes after the grace period.
    fireEvent.pointerLeave(aside);
    vi.advanceTimersByTime(1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("row Copy link", () => {
  beforeEach(() => vi.spyOn(toastModule, "showToast").mockReturnValue(1));
  afterEach(() => vi.mocked(toastModule.showToast).mockRestore());
  it("copies an inactive row without navigation, sharing or permission changes", async () => {
    mockConversations([CONV, { ...CONV, id: "other", title: "Other" }]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderSidebar(CONV.id);
    fireEvent.contextMenu(screen.getByRole("link", { name: "Other" }));
    fireEvent.click(screen.getByTestId("copy-conversation-link"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/c/other`),
    );
    expect(screen.getByRole("link", { name: "My Session" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await waitFor(() => expect(toastModule.showToast).toHaveBeenCalledWith("Link copied"));
    expect(mocks.leave.mutate).not.toHaveBeenCalled();
  });
  it("reports copy failure without claiming success", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
    });
    renderSidebar();
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    fireEvent.click(screen.getByTestId("copy-conversation-link"));
    await waitFor(() => expect(toastModule.showToast).toHaveBeenCalledWith("Couldn’t copy link"));
  });
});

describe("two compact status groups", () => {
  it.each([
    {
      status: "failed" as const,
      pending: 2,
      draft: true,
      unread: true,
      expected: ["error", "unseen"],
    },
    {
      status: "running" as const,
      pending: 2,
      draft: true,
      unread: true,
      expected: ["awaiting", "running"],
    },
    {
      status: "running" as const,
      pending: 0,
      draft: true,
      unread: true,
      expected: ["draft", "running"],
    },
    { status: "running" as const, pending: 0, draft: false, unread: true, expected: ["running"] },
    {
      status: "idle" as const,
      pending: 0,
      draft: true,
      unread: true,
      expected: ["draft", "unseen"],
    },
    { status: "idle" as const, pending: 0, draft: false, unread: false, expected: [] },
  ])(
    "selects $expected without long pills and retains lower facts",
    ({ status, pending, draft, unread, expected }) => {
      mockConversations([{ ...CONV, status, pending_elicitations_count: pending }]);
      if (draft) setSessionDraft(CONV.id, { text: "Unsent work", files: [] });
      if (unread) markConversationUnread(CONV.id, CONV.updated_at);
      renderSidebar();
      const row = screen.getByRole("link", { name: /My Session/ }).closest("li")!;
      expect(
        within(row)
          .queryAllByTestId("session-state-badge")
          .map((badge) => badge.getAttribute("data-state")),
      ).toEqual(expected);
      expect(within(row).queryByText("Needs response")).toBeNull();
      const menu = within(row).getByTestId("conversation-actions");
      expect(menu).toHaveClass("size-6", "shrink-0", "[@media(pointer:coarse)]:size-11");
      expect(menu.querySelector("button, [role=button]")).toBeNull();
      if (pending)
        expect(menu).toHaveAccessibleDescription(
          expect.stringContaining(`${pending} approval prompts waiting`),
        );
      if (draft) expect(menu).toHaveAccessibleDescription(expect.stringContaining("Draft"));
      if (unread) expect(menu).toHaveAccessibleDescription(expect.stringContaining("New messages"));
      expect(within(row).queryByTestId("conversation-secondary-indicator") !== null).toBe(
        expected.length === 2,
      );
    },
  );

  it("opens the same menu with one tap on a status beside the independent actions", () => {
    mocks.isMobile = true;
    mockConversations([{ ...CONV, status: "running", pending_elicitations_count: 2 }]);
    renderSidebar(CONV.id);
    const currentLink = screen.getByRole("link", { name: "My Session" });
    const status = screen.getAllByRole("button", { name: "Session status" })[0];
    const archive = screen.getByTestId("quick-archive-conversation");
    expect(status.parentElement).toBe(archive.parentElement);
    expect(status).toHaveAccessibleDescription(
      expect.stringContaining("2 approval prompts waiting"),
    );
    fireEvent.pointerDown(status, { pointerType: "touch", button: 0 });
    fireEvent.pointerUp(status, { pointerType: "touch", button: 0 });
    fireEvent.click(status);
    expect(screen.getByTestId("rename-conversation")).toBeInTheDocument();
    expect(currentLink).toHaveAttribute("aria-current", "page");
  });
});
