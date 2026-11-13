import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalResourceView, RetainedActivityView } from "./TerminalResourceView";
import { authenticatedFetch } from "@/lib/identity";
import { useSession } from "@/hooks/useSession";
import { terminalHistoryKey } from "./TerminalInventoryView";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ session: null, error: null, isLoading: false })),
}));
vi.mock("@/hooks/RunnerHealthProvider", () => ({ useSessionRunnerOnline: () => true }));
vi.mock("@/lib/notifications", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/blocks/TerminalView", () => ({
  TerminalView: (props: {
    workspaceId?: string;
    sessionId: string;
    terminalId: string;
    readOnly: boolean;
    active: boolean;
  }) => (
    <div
      data-testid="terminal"
      data-workspace={props.workspaceId}
      data-session={props.sessionId}
      data-terminal={props.terminalId}
      data-readonly={String(props.readOnly)}
      data-active={String(props.active)}
    />
  ),
}));
const workspace: WorkbenchWorkspace = {
  id: "workspace-a",
  root: "/repo",
  host_id: "host-a",
  target_kind: "host",
  capabilities: ["terminals"],
  permission_level: 4,
};
const fetchMock = vi.mocked(authenticatedFetch);
const row = (state = "running", connectivity = "connected") => ({
  id: "shell-a",
  name: "bash",
  state,
  connectivity,
  metadata: {
    terminal_name: "bash",
    session_key: "shell-a",
    output: "captured output",
    exit_code: state === "exited" ? 7 : null,
  },
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(useSession).mockReturnValue({ session: null, error: null, isLoading: false });
});

it("opens a recorded command through its owner without attaching or launching a shell", async () => {
  fetchMock.mockResolvedValue(
    response({
      data: [
        {
          id: "command-1",
          kind: "command",
          name: "printf result",
          state: "exited",
          session_id: "child-owner",
          output: "\u001b[32mresult\u001b[0m",
          exit_status: 0,
          owner_kind: "chat",
          owner_id: "child-owner",
        },
      ],
    }),
  );
  const { wrapper } = setup();
  render(
    <RetainedActivityView
      conversationId="child-owner"
      activity={{ name: "Build checks", state: "exited", entryIds: ["command-1"] }}
      active
    />,
    { wrapper },
  );
  const output = await screen.findByLabelText("Retained shell output");
  expect(output).toHaveTextContent("$ printf result");
  expect(output).toHaveTextContent("result");
  expect(output.textContent).not.toContain("\u001b");
  expect(screen.queryByTestId("terminal")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("/v1/sessions/child-owner/activity");
});

it("attaches a manual shell to its workspace and unmounting never stops it", async () => {
  fetchMock.mockResolvedValue(response(row()));
  const { wrapper } = setup();
  const view = render(
    <TerminalResourceView
      workspace={workspace}
      conversationId="unrelated"
      terminalId="shell-a"
      active
    />,
    { wrapper },
  );
  const terminal = await screen.findByTestId("terminal");
  expect(terminal).toHaveAttribute("data-workspace", workspace.id);
  expect(terminal).toHaveAttribute("data-session", "");
  expect(terminal).toHaveAttribute("data-readonly", "false");
  view.unmount();
  expect(
    fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === "GET"),
  ).toBe(true);
});

it.each(["exited", "stopped"])(
  "reopens %s output offline without attempting a live attach",
  async (state) => {
    fetchMock.mockResolvedValue(response(row(state, "disconnected")));
    render(<TerminalResourceView workspace={workspace} terminalId="shell-a" active />, {
      wrapper: setup().wrapper,
    });
    expect(await screen.findByLabelText("Retained shell output")).toHaveTextContent(
      "captured output",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      state === "exited" ? "Exited (code 7)" : "Stopped",
    );
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop shell" })).not.toBeInTheDocument();
  },
);

it("does not confuse an offline running snapshot with an ended process", async () => {
  fetchMock.mockResolvedValue(response(row("running", "disconnected")));
  render(<TerminalResourceView workspace={workspace} terminalId="shell-a" active />, {
    wrapper: setup().wrapper,
  });
  expect(await screen.findByLabelText("Retained shell output")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("process state unconfirmed");
  expect(screen.getByRole("button", { name: "Stop shell" })).toBeDisabled();
});

it("confirms stop, waits for the result, and keeps authoritative stopped output", async () => {
  const pending = deferred<Response>();
  let stopped = false;
  fetchMock.mockImplementation(async (_path, options) =>
    options?.method === "DELETE" ? pending.promise : response(row(stopped ? "stopped" : "running")),
  );
  const { wrapper } = setup();
  render(<TerminalResourceView workspace={workspace} terminalId="shell-a" active />, { wrapper });
  await screen.findByTestId("terminal");
  fireEvent.click(screen.getByRole("button", { name: "Stop shell" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Close shell" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Stopping…"));
  expect(screen.getByRole("button", { name: "Stop shell" })).toBeDisabled();
  stopped = true;
  await act(async () => pending.resolve(response(row("stopped"))));
  expect(await screen.findByLabelText("Retained shell output")).toHaveTextContent(
    "captured output",
  );
  expect(screen.getByRole("status")).toHaveTextContent("Stopped");
});

it("keeps a failed stop visible without claiming the shell stopped", async () => {
  fetchMock.mockImplementation(async (_path, options) =>
    options?.method === "DELETE"
      ? response({ error: { message: "permission revoked" } }, 403)
      : response(row()),
  );
  render(<TerminalResourceView workspace={workspace} terminalId="shell-a" active />, {
    wrapper: setup().wrapper,
  });
  await screen.findByTestId("terminal");
  fireEvent.click(screen.getByRole("button", { name: "Stop shell" }));
  fireEvent.click(screen.getByRole("button", { name: "Close shell" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("permission revoked");
  expect(screen.getByRole("status")).toHaveTextContent("Running");
  expect(screen.getByTestId("terminal")).toBeVisible();
});

it("keeps an in-flight stop scoped to its old workspace after retargeting", async () => {
  const pending = deferred<Response>();
  fetchMock.mockImplementation(async (_path, options) =>
    options?.method === "DELETE" ? pending.promise : response(row()),
  );
  const { wrapper, client } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(<TerminalResourceView workspace={workspace} terminalId="shell-a" active />, {
    wrapper,
  });
  await screen.findByTestId("terminal");
  fireEvent.click(screen.getByRole("button", { name: "Stop shell" }));
  fireEvent.click(screen.getByRole("button", { name: "Close shell" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(true),
  );
  view.rerender(
    <TerminalResourceView
      workspace={{ ...workspace, id: "workspace-b" }}
      terminalId="shell-a"
      active
    />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-workspace", "workspace-b"),
  );
  await act(async () => pending.resolve(response(row("stopped"))));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: terminalHistoryKey(workspace.id) });
  expect(screen.getByRole("status")).toHaveTextContent("Running");
  expect(
    fetchMock.mock.calls
      .filter(([, options]) => options?.method === "DELETE")
      .map(([path]) => path),
  ).toEqual(["/v1/workbench-workspaces/workspace-a/terminals/shell-a"]);
});

it("uses session authority and session attachment for agent-owned terminals even with a workspace prop", async () => {
  const { wrapper } = setup();
  const view = render(
    <TerminalResourceView
      workspace={workspace}
      conversationId="agent-chat"
      terminalId="terminal_codex_main"
      manual={false}
      active
    />,
    { wrapper },
  );
  expect(await screen.findByTestId("terminal")).toHaveAttribute("data-readonly", "true");
  vi.mocked(useSession).mockReturnValue({
    session: { permissionLevel: 1 } as never,
    error: null,
    isLoading: false,
  });
  view.rerender(
    <TerminalResourceView
      workspace={workspace}
      conversationId="agent-chat"
      terminalId="terminal_codex_main"
      manual={false}
      active
    />,
  );
  expect(screen.getByTestId("terminal")).toHaveAttribute("data-session", "agent-chat");
  expect(screen.getByTestId("terminal")).not.toHaveAttribute("data-workspace");
  expect(screen.getByTestId("terminal")).toHaveAttribute("data-readonly", "true");
  expect(useSession).toHaveBeenCalledWith("agent-chat");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Stop shell" })).not.toBeInTheDocument();
});

it("does not grant shell writes when workspace authority is unknown", async () => {
  fetchMock.mockResolvedValue(response(row()));
  render(
    <TerminalResourceView
      workspace={{ ...workspace, permission_level: undefined }}
      terminalId="shell-a"
      active
    />,
    { wrapper: setup().wrapper },
  );
  expect(await screen.findByTestId("terminal")).toHaveAttribute("data-readonly", "true");
  expect(screen.getByRole("button", { name: "Stop shell" })).toBeDisabled();
});

it("does not reinterpret a manual shell as a session terminal when workspace metadata is missing", async () => {
  vi.mocked(useSession).mockReturnValue({
    session: { permissionLevel: 4 } as never,
    error: null,
    isLoading: false,
  });
  render(<TerminalResourceView conversationId="chat" terminalId="shell-a" active />, {
    wrapper: setup().wrapper,
  });
  expect(screen.getByText("Choose a workspace to open this manual shell.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Stop shell" })).toBeDisabled();
  expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("does not label an acknowledged stop as stopped while the server still reports running", async () => {
  fetchMock.mockImplementation(async (_path, options) =>
    response(options?.method === "DELETE" ? { accepted: true } : row()),
  );
  render(<TerminalResourceView workspace={workspace} terminalId="shell-a" active />, {
    wrapper: setup().wrapper,
  });
  await screen.findByTestId("terminal");
  fireEvent.click(screen.getByRole("button", { name: "Stop shell" }));
  fireEvent.click(screen.getByRole("button", { name: "Close shell" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(2),
  );
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Running"));
  expect(screen.queryByText("Stopped")).not.toBeInTheDocument();
});

it("rechecks authority before confirming Stop and allows cancellation without a request", async () => {
  fetchMock.mockResolvedValue(response(row()));
  const view = render(<TerminalResourceView workspace={workspace} terminalId="shell-a" active />, {
    wrapper: setup().wrapper,
  });
  await screen.findByTestId("terminal");
  fireEvent.click(screen.getByRole("button", { name: "Stop shell" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Stop shell" }));
  view.rerender(
    <TerminalResourceView
      workspace={{ ...workspace, permission_level: 1 }}
      terminalId="shell-a"
      active
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close shell" }));
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  expect(screen.getByTestId("terminal")).toHaveAttribute("data-readonly", "true");
});
