// Modified for Triune.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConversations, useSessionSearch } from "@/hooks/useConversations";
import { useHosts } from "@/hooks/useHosts";
import { useViewerId } from "@/hooks/useViewerId";
import { authenticatedFetch } from "@/lib/identity";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import type { ChatActivityPanelProps } from "@/shell/ChatActivityPanel";
import type { WorkspaceSelectionDialogProps } from "@/shell/WorkspaceSelectionDialog";
import { ActivityView, type ActivityViewProps } from "./ActivityView";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/hooks/useHosts", () => ({ useHosts: vi.fn() }));
vi.mock("@/hooks/useViewerId", () => ({ useViewerId: vi.fn() }));
vi.mock("@/lib/resourceViewStorage", () => ({ resourceViewStorageScope: vi.fn() }));
vi.mock("@/hooks/useConversations", () => ({
  useConversations: vi.fn(),
  useSessionSearch: vi.fn(),
}));
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ session: { title: "Captured chat" } }),
}));
vi.mock("@/shell/ChatActivityPanel", () => ({
  ChatActivityPanel: ({
    conversationId,
    rootSessionId,
    sourceControl,
    focusAgentId,
    linkRequestId,
  }: ChatActivityPanelProps) => (
    <div
      data-testid="chat-activity"
      data-conversation={conversationId}
      data-root={rootSessionId}
      data-focus-agent={focusAgentId}
      data-link-request={linkRequestId}
    >
      {sourceControl}
    </div>
  ),
}));
vi.mock("@/shell/WorkspaceSelectionDialog", () => ({
  WorkspaceSelectionDialog: ({
    hostId,
    onConfirm,
    onOpenChange,
  }: WorkspaceSelectionDialogProps) => (
    <div role="dialog" aria-label="Workspace">
      <button type="button" onClick={() => void onConfirm({ hostId, path: "/chosen" })}>
        Confirm root
      </button>
      <button type="button" onClick={() => onOpenChange(false)}>
        Cancel root
      </button>
    </div>
  ),
}));

const workspace: WorkbenchWorkspace = {
  id: "workspace-a",
  host_id: "host-a",
  target_kind: "host",
  root: "/repo",
  capabilities: ["terminals"],
  permission_level: 4,
};
const fetchMock = vi.mocked(authenticatedFetch);
const json = (body: unknown) => new Response(JSON.stringify(body));
const list = (rows: unknown[]) => json({ data: rows });
const shell = (name: string, state = "running") => ({
  id: "same-terminal-id",
  name,
  state,
  connectivity: "connected",
  metadata: { output: `retained ${name}` },
});
const defaults = (): ActivityViewProps => ({
  onSourceChange: vi.fn(),
  onOpenTerminal: vi.fn(),
  onNewTerminal: vi.fn(),
});
function setup(props: ActivityViewProps) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ActivityView {...props} />, { wrapper });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(useViewerId).mockReturnValue("viewer-a");
  vi.mocked(resourceViewStorageScope).mockReturnValue('["server-a","viewer-a"]');
  vi.mocked(useHosts).mockReturnValue({
    data: [
      { host_id: "host-a", name: "Host A", status: "online" },
      { host_id: "host-b", name: "Host B", status: "offline" },
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useHosts>);
  const chats = {
    data: { pages: [{ data: [{ id: "permitted-chat", title: "Permitted chat", labels: {} }] }] },
    isLoading: false,
    error: null,
  };
  vi.mocked(useConversations).mockReturnValue(
    chats as unknown as ReturnType<typeof useConversations>,
  );
  vi.mocked(useSessionSearch).mockReturnValue(
    chats as unknown as ReturnType<typeof useSessionSearch>,
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("forwards an explicit completed-agent target and repeated-open request to the captured chat", () => {
  setup({
    ...defaults(),
    source: { kind: "chat", conversationId: "captured-chat" },
    focusAgentId: "done-agent",
    linkRequestId: "open-again",
  });
  expect(screen.getByTestId("chat-activity")).toHaveAttribute("data-conversation", "captured-chat");
  expect(screen.getByTestId("chat-activity")).toHaveAttribute("data-focus-agent", "done-agent");
  expect(screen.getByTestId("chat-activity")).toHaveAttribute("data-link-request", "open-again");
});

it("starts unselected and offers real host/chat groups, capturing an authorized root on selection", async () => {
  fetchMock.mockResolvedValue(list([workspace]));
  const props = defaults();
  setup(props);
  expect(screen.getByText("Choose a host or chat to view its activity.")).toBeVisible();
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Choose orchestration source/ }));
  expect(screen.getByRole("group", { name: "Hosts" })).toBeVisible();
  expect(screen.getByRole("group", { name: "Chats" })).toBeVisible();
  expect(useSessionSearch).toHaveBeenLastCalledWith("", "title", {
    enabled: true,
    cacheIdentity: '["server-a","viewer-a"]',
  });
  fireEvent.click(screen.getByRole("option", { name: "Host A" }));
  await waitFor(() =>
    expect(props.onSourceChange).toHaveBeenCalledWith({
      kind: "host",
      hostId: "host-a",
      workspace,
    }),
  );
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/v1/workbench-workspaces"]);
  expect(screen.queryByTestId("chat-activity")).not.toBeInTheDocument();
});

it.each(["account", "server"])("does not expose cached roots after a %s change", async (change) => {
  let resolve!: (response: Response) => void;
  fetchMock.mockImplementation(async (path) =>
    path === "/v1/workbench-workspaces"
      ? list([workspace])
      : json({ data: [shell("old-shell")], available: true }),
  );
  const props = { ...defaults(), source: { kind: "host", hostId: "host-a", workspace } as const };
  const view = setup(props);
  await screen.findByRole("button", { name: "old-shell" });
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.mocked(resourceViewStorageScope).mockReturnValue(
    change === "account" ? '["server-a","viewer-b"]' : '["server-b","viewer-a"]',
  );
  if (change === "account") vi.mocked(useViewerId).mockReturnValue("viewer-b");
  view.rerender(<ActivityView {...props} />);
  expect(screen.queryByRole("region", { name: "Shell inventory · /repo" })).not.toBeInTheDocument();
  await waitFor(() => expect(resolve).toBeDefined());
  await act(async () => {
    resolve(list([]));
  });
  expect(screen.queryByRole("button", { name: "old-shell" })).not.toBeInTheDocument();
});

it("keeps a captured chat until persistence succeeds and displays rejected source changes", async () => {
  const props = {
    ...defaults(),
    source: { kind: "chat", conversationId: "captured-chat" } as const,
  };
  vi.mocked(props.onSourceChange).mockRejectedValueOnce(new Error("Layout changed; retry"));
  const view = setup(props);
  expect(screen.getByTestId("chat-activity")).toHaveAttribute("data-root", "captured-chat");
  fireEvent.click(screen.getByRole("button", { name: /Choose orchestration source/ }));
  fireEvent.click(screen.getByRole("option", { name: "Permitted chat" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Layout changed; retry");
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.getByTestId("chat-activity")).toHaveAttribute("data-conversation", "captured-chat");
  fireEvent.click(screen.getByRole("option", { name: "Permitted chat" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(props.onSourceChange).toHaveBeenLastCalledWith({
    kind: "chat",
    conversationId: "permitted-chat",
  });
  view.rerender(<ActivityView {...props} />);
  expect(screen.getByTestId("chat-activity")).toHaveAttribute("data-conversation", "captured-chat");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("composes host inventories by root and opens exact workspace terminals including ended history", async () => {
  const second = { ...workspace, id: "workspace-second", root: "/other" };
  fetchMock.mockImplementation(async (path) => {
    if (path === "/v1/workbench-workspaces")
      return list([
        workspace,
        second,
        { ...workspace, id: "foreign", host_id: "host-b" },
        { ...workspace, id: "isolated", target_kind: "runneronly" },
      ]);
    return json({
      data: [
        shell(
          String(path).includes("workspace-second") ? "ended" : "live",
          String(path).includes("workspace-second") ? "exited" : "running",
        ),
      ],
      available: true,
    });
  });
  const props = { ...defaults(), source: { kind: "host", hostId: "host-a", workspace } as const };
  const { container } = setup(props);
  const region = await screen.findByRole("region", { name: "Shell inventory · /other" });
  fireEvent.click(await within(region).findByRole("button", { name: "ended" }));
  expect(props.onOpenTerminal).toHaveBeenCalledWith({
    workspaceId: second.id,
    sessionId: "",
    terminalId: "same-terminal-id",
  });
  expect(within(region).getByText("Exited")).toBeVisible();
  fireEvent.click(within(region).getByRole("button", { name: "Expand activity" }));
  expect(within(region).getByLabelText("Retained shell output")).toHaveTextContent(
    "retained ended",
  );
  fireEvent.click(within(region).getByRole("button", { name: "New shell" }));
  expect(props.onNewTerminal).toHaveBeenCalledWith(second);
  expect(container.querySelectorAll(".workspace-control-header")).toHaveLength(1);
  expect(
    fetchMock.mock.calls.some(([path]) => /foreign|isolated|\/sessions\//.test(String(path))),
  ).toBe(false);
});

it("does not trust a persisted workspace to authorize an absent host", async () => {
  fetchMock.mockResolvedValue(list([workspace]));
  setup({ ...defaults(), source: { kind: "host", hostId: "missing-host", workspace } });
  expect(await screen.findByText("Host unavailable. Refresh to check access.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Choose workspace" })).toBeDisabled();
  expect(screen.queryByRole("region", { name: /Shell inventory/ })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.every(([path]) => path === "/v1/workbench-workspaces")).toBe(true);
});

it("resolves the chosen host/root and ignores its late result after an origin switch", async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockImplementation(async (_path, options) =>
    options?.method === "POST"
      ? new Promise<Response>((done) => {
          resolve = done;
        })
      : list([workspace]),
  );
  const props = { ...defaults(), source: { kind: "host", hostId: "host-a", workspace } as const };
  const view = setup(props);
  fireEvent.click(await screen.findByRole("button", { name: "Choose workspace" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel root" }));
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Choose workspace" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm root" }));
  await waitFor(() => expect(resolve).toBeDefined());
  expect(fetchMock).toHaveBeenCalledWith(
    "/v1/workbench-workspaces",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ host_id: "host-a", root: "/chosen" }),
    }),
  );
  const chosen = { ...workspace, id: "chosen", root: "/chosen" };
  await act(async () => {
    resolve(json(chosen));
  });
  expect(props.onSourceChange).toHaveBeenCalledWith({
    kind: "host",
    hostId: "host-a",
    workspace: chosen,
  });
  vi.mocked(props.onSourceChange).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Confirm root" }));
  view.rerender(
    <ActivityView {...props} source={{ kind: "chat", conversationId: "another-chat" }} />,
  );
  await act(async () => {
    resolve(json({ ...workspace, id: "chosen", root: "/chosen" }));
  });
  expect(props.onSourceChange).not.toHaveBeenCalled();
  expect(screen.getByTestId("chat-activity")).toHaveAttribute("data-conversation", "another-chat");
});
