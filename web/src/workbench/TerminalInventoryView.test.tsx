// Modified for Triune.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalInventoryView } from "./TerminalInventoryView";
import { authenticatedFetch } from "@/lib/identity";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/hooks/RunnerHealthProvider", () => ({ useSessionRunnerOnline: () => true }));
vi.mock("@/lib/notifications", () => ({ toast: { error: vi.fn() } }));
const workspace: WorkbenchWorkspace = {
  id: "workspace-a",
  root: "/repo",
  host_id: "host-a",
  target_kind: "host",
  capabilities: ["terminals"],
  permission_level: 4,
};
const fetchMock = vi.mocked(authenticatedFetch);
const row = (id: string, state = "running", connectivity = "connected") => ({
  id,
  name: id,
  running: connectivity === "connected" && state === "running",
  state,
  connectivity,
  metadata: { output: `retained ${id}`, exit_code: state === "exited" ? 9 : null },
});
const response = (data: unknown[], available = true) =>
  new Response(JSON.stringify({ data, available }));
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  fetchMock.mockReset();
});

it("lists and reopens running, ended and unknown manual shells without creating or stopping them", async () => {
  fetchMock.mockResolvedValue(
    response([
      row("live"),
      row("ended", "exited"),
      row("stopped", "stopped"),
      row("unknown", "unknown"),
    ]),
  );
  const open = vi.fn();
  const create = vi.fn();
  render(
    <TerminalInventoryView
      workspace={workspace}
      active
      onOpenTerminal={open}
      onNewTerminal={create}
    />,
    { wrapper: setup() },
  );
  fireEvent.click(await screen.findByRole("button", { name: "ended" }));
  expect(open).toHaveBeenCalledWith("ended");
  expect(screen.getByText("Exited (code 9)")).toBeVisible();
  expect(screen.getByText("Stopped")).toBeVisible();
  expect(screen.getByText("Process state unknown")).toBeVisible();
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "New shell" }));
  expect(create).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    "/v1/workbench-workspaces/workspace-a/terminals",
  ]);
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it("shows offline retained output and leaves uncertain processes unconfirmed", async () => {
  fetchMock.mockResolvedValue(response([row("offline", "running", "disconnected")], false));
  render(
    <TerminalInventoryView
      workspace={workspace}
      active
      onOpenTerminal={vi.fn()}
      onNewTerminal={vi.fn()}
    />,
    { wrapper: setup() },
  );
  expect(await screen.findByText("Host offline. Showing retained shell records.")).toBeVisible();
  expect(screen.getByText("Offline · process state unconfirmed")).toBeVisible();
  expect(screen.getByRole("button", { name: "New shell" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
  expect(screen.getByLabelText("Retained shell output")).toHaveTextContent("retained offline");
});

it.each([undefined, 1, 3])(
  "keeps reopening available without granting creation at permission %s",
  async (permission_level) => {
    fetchMock.mockResolvedValue(response([row("old", "stopped")]));
    const open = vi.fn();
    render(
      <TerminalInventoryView
        workspace={{ ...workspace, permission_level }}
        active
        onOpenTerminal={open}
        onNewTerminal={vi.fn()}
      />,
      { wrapper: setup() },
    );
    fireEvent.click(await screen.findByRole("button", { name: "old" }));
    expect(open).toHaveBeenCalledWith("old");
    expect(screen.getByRole("button", { name: "New shell" })).toBeDisabled();
  },
);

it("does not fetch hidden inventories or let a late response replace the selected workspace", async () => {
  let resolveA!: (response: Response) => void;
  const pendingA = new Promise<Response>((resolve) => {
    resolveA = resolve;
  });
  fetchMock.mockImplementation(async (path) =>
    String(path).includes("workspace-a") ? pendingA : response([row("b-shell")]),
  );
  const view = render(
    <TerminalInventoryView
      workspace={workspace}
      active={false}
      onOpenTerminal={vi.fn()}
      onNewTerminal={vi.fn()}
    />,
    { wrapper: setup() },
  );
  expect(fetchMock).not.toHaveBeenCalled();
  view.rerender(
    <TerminalInventoryView
      workspace={workspace}
      active
      onOpenTerminal={vi.fn()}
      onNewTerminal={vi.fn()}
    />,
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  view.rerender(
    <TerminalInventoryView
      workspace={{ ...workspace, id: "workspace-b" }}
      active
      onOpenTerminal={vi.fn()}
      onNewTerminal={vi.fn()}
    />,
  );
  expect(await screen.findByRole("button", { name: "b-shell" })).toBeVisible();
  await act(async () => resolveA(response([row("a-shell")])));
  expect(screen.queryByRole("button", { name: "a-shell" })).not.toBeInTheDocument();
});

it.each(["http", "network"])("retains rows and displays %s refresh failures", async (failure) => {
  fetchMock
    .mockResolvedValueOnce(response([row("retained", "stopped")]))
    .mockImplementation(async () => {
      if (failure === "network") throw new TypeError("network unavailable");
      return new Response(JSON.stringify({ error: { message: "network unavailable" } }), {
        status: 503,
      });
    });
  render(
    <TerminalInventoryView
      workspace={workspace}
      active
      onOpenTerminal={vi.fn()}
      onNewTerminal={vi.fn()}
    />,
    { wrapper: setup() },
  );
  await screen.findByRole("button", { name: "retained" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh shells" }));
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("network unavailable");
  expect(screen.getByRole("button", { name: "retained" })).toBeVisible();
  expect(screen.getByRole("button", { name: "New shell" })).toBeDisabled();
});

it("uses two-line embedded rows, sorts observed exit activity and stops only an owner-authorized live shell", async () => {
  const live = { ...row("live"), metadata: { output: "live output", created_at: 300 } };
  const old = {
    ...row("old", "exited"),
    metadata: { output: "saved output", created_at: 100, exited_at: 500 },
  };
  fetchMock.mockImplementation(async (_path, options) =>
    options?.method === "DELETE" ? new Response(null, { status: 204 }) : response([live, old]),
  );
  const open = vi.fn();
  const view = render(
    <TerminalInventoryView
      workspace={workspace}
      active
      embedded
      onOpenTerminal={open}
      onNewTerminal={vi.fn()}
    />,
    { wrapper: setup() },
  );
  await screen.findByRole("button", { name: "old" });
  expect(
    screen
      .getAllByRole("button")
      .filter((button) => ["old", "live"].includes(button.getAttribute("aria-label") ?? ""))
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["old", "live"]);
  expect(screen.queryByRole("button", { name: "Stop old" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop live" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/v1/workbench-workspaces/workspace-a/terminals/live", {
      method: "DELETE",
    }),
  );
  expect(open).not.toHaveBeenCalled();
  view.rerender(
    <TerminalInventoryView
      workspace={{ ...workspace, permission_level: 1 }}
      active
      embedded
      onOpenTerminal={open}
      onNewTerminal={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "Stop live" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "old" }));
  expect(open).toHaveBeenCalledWith("old");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Expand activity" })).not.toBeInTheDocument();
});
