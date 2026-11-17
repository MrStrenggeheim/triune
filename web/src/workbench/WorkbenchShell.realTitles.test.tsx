// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarDataProvider } from "@/hooks/useSidebarData";
import { sidebarConfig } from "@/lib/sidebarConfig";
import { conversationRegistry } from "@/store/conversationRegistry";
import { initChatStore } from "@/store/chatStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkbenchShell } from "./WorkbenchShell";
import { getSessionDraft, setSessionDraft } from "@/lib/sessionDrafts";
import { dockStorageKey, updateDockConversationTitles } from "./dockPersistence";
import type * as DockHookModule from "./useDockLayout";
import type * as DockPersistenceModule from "./dockPersistence";
import type * as HostModule from "@/lib/host";

const observed = vi.hoisted(() => ({
  dock: null as ReturnType<typeof DockHookModule.useDockLayout> | null,
  search: {
    close: vi.fn(),
    openSearch: vi.fn(),
    openResult: vi.fn(),
    setQuery: vi.fn(),
    setMessageFilter: vi.fn(),
  },
}));
vi.mock("./useDockLayout", async (original) => {
  const real = await original<typeof DockHookModule>();
  return {
    ...real,
    useDockLayout: (...args: Parameters<typeof real.useDockLayout>) => {
      const dock = real.useDockLayout(...args);
      observed.dock = dock;
      return dock;
    },
  };
});
vi.mock("./dockPersistence", async (original) => {
  const real = await original<typeof DockPersistenceModule>();
  return { ...real, updateDockConversationTitles: vi.fn(real.updateDockConversationTitles) };
});
vi.mock("@/hooks/useViewerId", () => ({
  useViewerId: () => "local",
  useIdentityReady: () => true,
}));
vi.mock("@/lib/host", async (original) => ({
  ...(await original<typeof HostModule>()),
  getOmnigentServerIdentity: () => "title-server",
}));
vi.mock("@/hooks/useContextSearchController", () => ({
  useContextSearchController: () => observed.search,
}));
vi.mock("./WorkbenchBindings", () => ({ WorkbenchBindings: () => null }));
vi.mock("./WorkbenchAppBar", () => ({ WorkbenchAppBar: () => null }));
vi.mock("@/shell/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./OpenLocationDialog", () => ({ OpenLocationDialog: () => null }));
vi.mock("@/components/onboarding/HostImportReview", () => ({ ImportReviewGate: () => null }));
vi.mock("@/components/OverlayScrollbars", () => ({ OverlayScrollbars: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/NotificationCenter", () => ({
  NotificationLayoutProvider: ({ children }: { children: ReactNode }) => children,
}));
// Keep the real conversation header, metadata hooks and scoped observation owner.
// Transcript rendering and unrelated file resources are outside this title test.
vi.mock("./ScopedConversationSurface", () => ({ ScopedConversationSurface: () => null }));
vi.mock("./ResourceView", () => ({ ResourceView: () => null, inheritResourceViewState: () => {} }));
vi.mock("@/hooks/RunnerHealthProvider", () => ({
  useRunnerHealthRegistration: () => {},
  useSessionRunnerOnline: () => true,
  useSessionHostOnline: () => true,
}));
vi.mock("@/hooks/useBrowserAgentRelay", () => ({ useBrowserAgentRelay: () => {} }));
vi.mock("@/hooks/useUiOpenFile", () => ({ useUiOpenFile: () => {} }));

const saved = {
  version: 1,
  shared: {
    version: 1,
    tree: "main",
    panes: [
      {
        id: "main",
        viewIds: ["conversation:workspace-a"],
        selectedViewId: "conversation:workspace-a",
      },
    ],
    views: [
      {
        id: "conversation:workspace-a",
        kind: "conversation",
        title: "Chat A",
        resource: {
          conversationId: "workspace-a",
        },
      },
    ],
    focusedPaneId: "main",
  },
  chats: [
    {
      conversationId: "workspace-a",
      layout: {
        version: 1,
        tree: {
          axis: "columns",
          ratio: 0.5,
          children: ["main", "pane-1"],
        },
        panes: [
          {
            id: "main",
            viewIds: ["conversation:workspace-a", "042cba04-10b5-413c-90fb-7b7468d3b675"],
            selectedViewId: "042cba04-10b5-413c-90fb-7b7468d3b675",
          },
          {
            id: "pane-1",
            viewIds: ["993eec43-474a-43b7-8fa6-e274df6e68e1"],
            selectedViewId: "993eec43-474a-43b7-8fa6-e274df6e68e1",
          },
        ],
        views: [
          {
            id: "conversation:workspace-a",
            kind: "conversation",
            title: "Chat A",
            resource: {
              conversationId: "workspace-a",
            },
          },
          {
            id: "993eec43-474a-43b7-8fa6-e274df6e68e1",
            kind: "files",
            title: "Explorer",
            resource: {
              kind: "files",
              workspace: {
                id: "workspace-files",
                root: "/workspace",
                host_id: "browser-chat-host",
                target_kind: "host",
                available: true,
                permission_level: 4,
                capabilities: ["files", "git", "terminals"],
              },
              conversationId: "workspace-a",
            },
          },
          {
            id: "042cba04-10b5-413c-90fb-7b7468d3b675",
            kind: "preview",
            title: "notes.py",
            resource: {
              kind: "preview",
              workspace: {
                id: "workspace-files",
                root: "/workspace",
                host_id: "browser-chat-host",
                target_kind: "host",
                available: true,
                permission_level: 4,
                capabilities: ["files", "git", "terminals"],
              },
              conversationId: "workspace-a",
              path: "notes.py",
              fileOptions: {
                workspaceId: "workspace-files",
                workspace: {
                  id: "workspace-files",
                  root: "/workspace",
                  host_id: "browser-chat-host",
                  target_kind: "host",
                  available: true,
                  permission_level: 4,
                  capabilities: ["files", "git", "terminals"],
                },
                sourceViewId: "993eec43-474a-43b7-8fa6-e274df6e68e1",
                comparisonScope: "files",
                comparison: {
                  source: "git",
                  base: "HEAD",
                  target: "WORKTREE",
                },
              },
              sourceViewId: "993eec43-474a-43b7-8fa6-e274df6e68e1",
            },
          },
        ],
        focusedPaneId: "main",
      },
    },
  ],
  pins: {
    version: 1,
    tree: null,
    panes: [],
    views: [],
    focusedPaneId: null,
  },
  pinEdge: "right",
  pinRatio: 0.25,
  activeConversationId: "workspace-a",
  focusedViewId: "042cba04-10b5-413c-90fb-7b7468d3b675",
  automaticChatLayouts: true,
};
const rows = Array.from({ length: 50 }, (_, index) => ({
  id: index === 0 ? "workspace-a" : index === 1 ? "workspace-b" : `cold-${index}`,
  title: index === 0 ? "Chat A" : index === 1 ? "Chat B" : `Cold ${index}`,
  object: "conversation",
  owner: "local",
  labels: {},
  created_at: 1,
  updated_at: 1,
  permission_level: 4,
  pending_elicitations_count: 0,
}));
const page = {
  object: "list",
  data: rows,
  first_id: rows[0]!.id,
  last_id: rows.at(-1)!.id,
  has_more: false,
};
const mineKey = ["conversations", "", false, null, "mine"];
const fetchMock = vi.fn();
let client: QueryClient;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  vi.stubGlobal("innerWidth", 1440);
  const matchMedia = window.matchMedia;
  vi.stubGlobal("matchMedia", (query: string) => ({
    ...matchMedia(query),
    matches: query === "(min-width: 768px)",
  }));
  localStorage.clear();
  conversationRegistry.clear();
  vi.mocked(updateDockConversationTitles).mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  initChatStore(client);
  client.setQueryData(mineKey, { pages: [page], pageParams: [undefined] });
  client.setQueryData(["pinned-conversations"], { conversations: [], filterHonored: true });
  localStorage.setItem(
    dockStorageKey({ accountId: "local", serverId: "title-server", clientId: "browser" }),
    JSON.stringify(saved),
  );
  fetchMock.mockReset().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test.local");
    const path = url.pathname;
    if (/\/sessions\/[^/]+\/stream$/.test(path))
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    if (/\/sessions\/[^/]+\/items$/.test(path))
      return Promise.resolve(json({ object: "list", data: [], has_more: false }));
    if (path === "/v1/sessions/projects") return Promise.resolve(json([]));
    const session = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (session)
      return Promise.resolve(
        json({
          ...rows.find((row) => row.id === session[1]),
          id: session[1],
          agent_id: "agent",
          status: "idle",
          pending_inputs: [],
          pending_elicitations: [],
          host_id: null,
        }),
      );
    if (path === "/v1/sessions") return Promise.resolve(json(page));
    if (path === "/v1/me") return Promise.resolve(json({ id: "local" }));
    if (path.includes("pinned"))
      return Promise.resolve(json({ conversations: [], data: [], filter_honored: true }));
    return Promise.resolve(
      json({ data: [], agents: [], hosts: [], projects: [], comments: [], terminals: [] }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  // jsdom has no negotiated server socket; keep the real SSE observation path.
  vi.stubGlobal("WebSocket", undefined);
});
afterEach(() => {
  cleanup();
  conversationRegistry.clear();
  client.clear();
  vi.unstubAllGlobals();
});

it("projects cached Chat B after the real sidebar changes a split file layout to its real conversation", async () => {
  const router = createMemoryRouter([{ path: "/c/:conversationId", element: <WorkbenchShell /> }], {
    initialEntries: ["/c/workspace-a"],
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SidebarDataProvider
          config={{
            ...sidebarConfig,
            sharedAvailable: false,
            pinsIncludeShared: false,
            inboxIncludesShared: false,
            mineRefreshMs: 1_000_000,
          }}
        >
          <RouterProvider router={router} />
        </SidebarDataProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("tab", { name: "notes.py" });
  await waitFor(() =>
    expect(vi.mocked(updateDockConversationTitles).mock.calls.at(-1)?.[1].get("workspace-b")).toBe(
      "Chat B",
    ),
  );
  expect(observed.dock!.retainedViews.some((view) => view.id === "conversation:workspace-b")).toBe(
    false,
  );
  setSessionDraft("workspace-a", { text: "Keep my unsent draft", files: [] });
  const owner = observed.dock!.layout;
  const writes = vi.spyOn(Storage.prototype, "setItem");
  const sidebar = screen.getByRole("complementary");
  fireEvent.click(within(sidebar).getByText("Chat B", { exact: true }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/c/workspace-b"));
  expect(
    await screen.findByRole("tabpanel", { name: "Chat B" }, { timeout: 5000 }),
  ).toHaveAttribute("data-dock-view", "conversation:workspace-b");
  expect(screen.getByRole("tab", { name: "Chat B" })).toHaveAttribute("aria-selected", "true");
  const descriptor = observed.dock!.retainedViews.find(
    (view) => view.id === "conversation:workspace-b",
  );
  expect(descriptor).toMatchObject({
    kind: "conversation",
    title: "Chat B",
    resource: { conversationId: "workspace-b" },
  });
  const persisted = JSON.parse(localStorage.getItem(observed.dock!.scopeKey)!);
  expect(
    persisted.chats.find(
      (chat: { conversationId: string }) => chat.conversationId === "workspace-b",
    ).layout.views[0].title,
  ).toBe("Chat B");
  const titled = observed.dock!.layout;
  const titleWrites = writes.mock.calls.filter(([key]) => key === observed.dock!.scopeKey).length;
  // Equal title data and selecting the focused view must not persist another batch.
  act(() => {
    client.setQueryData(mineKey, client.getQueryData(mineKey));
    observed.dock!.focusView("conversation:workspace-b");
  });
  expect(observed.dock!.layout).toBe(titled);
  expect(writes.mock.calls.filter(([key]) => key === observed.dock!.scopeKey)).toHaveLength(
    titleWrites,
  );
  fireEvent.click(within(sidebar).getByText("Chat A", { exact: true }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/c/workspace-a"));
  await screen.findByRole("tab", { name: "Chat A" });
  expect(observed.dock!.layout.panes.map((pane) => pane.viewIds)).toEqual(
    owner.panes.map((pane) => pane.viewIds),
  );
  expect(observed.dock!.layout.views.find((view) => view.kind === "preview")).toBe(
    owner.views.find((view) => view.kind === "preview"),
  );
  expect(observed.dock!.layout.views.find((view) => view.kind === "files")).toBe(
    owner.views.find((view) => view.kind === "files"),
  );
  expect(getSessionDraft("workspace-a")?.text).toBe("Keep my unsent draft");
  writes.mockRestore();
}, 15000);
