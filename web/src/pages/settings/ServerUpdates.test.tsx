import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerUpdatesProvider, ServerUpdateSettings } from "./ServerUpdates";
import { fetchServerUpdate, type ServerUpdate } from "@/lib/serverUpdateApi";
import type * as Identity from "@/lib/identity";

const mocks = vi.hoisted(() => ({
  admin: true,
  capability: true,
  fetch: vi.fn<typeof fetch>(),
}));
vi.mock("@/lib/identity", async (original) => ({
  ...(await original<typeof Identity>()),
  authenticatedFetch: mocks.fetch,
}));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => mocks.admin }));
vi.mock("@/hooks/useViewerId", () => ({ useViewerId: () => "admin" }));
vi.mock("@/lib/CapabilitiesContext", () => ({
  useServerInfo: () => ({ capabilities: { server_update: mocks.capability } }),
}));
const available: ServerUpdate = {
  status: "available",
  mode: "manual",
  release: "v2",
  current_release: "v1",
  release_notes: "Bug fixes",
  can_install: true,
  detail: "",
  automatic_idle_supported: true,
};
let client: QueryClient;
function mount() {
  render(
    <QueryClientProvider client={client}>
      <ServerUpdatesProvider>
        <input aria-label="Session draft" defaultValue="Keep this draft" />
        <ServerUpdateSettings />
      </ServerUpdatesProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.admin = true;
  mocks.capability = true;
  mocks.fetch.mockReset().mockImplementation(async () => Response.json(available));
  client = new QueryClient();
});
afterEach(() => {
  cleanup();
  client.clear();
  onlineManager.setOnline(true);
});

it.each([
  [false, true],
  [true, false],
])("avoids update requests for admin=%s and capability=%s", (admin, capability) => {
  mocks.admin = admin;
  mocks.capability = capability;
  mount();
  expect(screen.queryByText("Server updates")).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("starts asynchronously, defers locally, and sends only the explicitly reviewed release", async () => {
  let complete!: (r: Response) => void;
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  mount();
  const draft = screen.getByRole("textbox");
  expect(draft).toHaveValue("Keep this draft");
  await act(async () => complete(Response.json(available)));
  fireEvent.click(await screen.findByRole("button", { name: "Later" }));
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review update" }));
  mocks.fetch.mockResolvedValueOnce(
    Response.json({ ...available, status: "installing", can_install: false }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Update & restart" }));
  await screen.findByText(/Waiting for the server to reconnect/);
  expect(mocks.fetch).toHaveBeenLastCalledWith(
    "/api/server-update/install",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ release: "v2" }) }),
  );
  expect(screen.getByRole("textbox")).toBe(draft);
});

it.each(["unsupported", "unknown", "offline", "up_to_date", "failed"] as const)(
  "handles %s without an install prompt",
  async (status) => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({
        ...available,
        status,
        detail: "Status from server",
        automatic_idle_supported: false,
      }),
    );
    mount();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    if (status === "unsupported") expect(screen.queryByText("Server updates")).toBeNull();
    else expect(await screen.findByText("Status from server")).toBeVisible();
  },
);

it("reviews a failed eligible release and resubmits its exact ID only after confirmation", async () => {
  mocks.fetch.mockResolvedValueOnce(
    Response.json({ ...available, status: "failed", detail: "Health check failed." }),
  );
  mount();
  const retry = await screen.findByRole("button", { name: "Review and retry" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(retry);
  expect(screen.getByRole("dialog")).toHaveTextContent("Health check failed.");
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  mocks.fetch.mockResolvedValueOnce(
    Response.json({ ...available, status: "installing", can_install: false }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Update & restart" }));
  await screen.findByText(/Waiting for the server to reconnect/);
  expect(mocks.fetch).toHaveBeenLastCalledWith(
    "/api/server-update/install",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ release: available.release }),
    }),
  );
});

it("requires explicit opt-in for automatic install and disables changes while disconnected", async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ ...available, status: "up_to_date" }));
  mount();
  const toggle = await screen.findByRole("switch");
  expect(toggle).not.toBeChecked();
  mocks.fetch.mockResolvedValueOnce(
    Response.json({ ...available, status: "up_to_date", mode: "automatic_idle" }),
  );
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(mocks.fetch).toHaveBeenLastCalledWith(
    "/api/server-update/mode",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ mode: "automatic_idle" }) }),
  );
  act(() => onlineManager.setOnline(false));
  expect(toggle).toBeDisabled();
  expect(screen.getByText("Disconnected from the server.")).toBeVisible();
});

it("rejects invalid status and submits a bodyless explicit check", async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ status: "available" }));
  await expect(fetchServerUpdate({ action: "check" })).rejects.toThrow();
  expect(mocks.fetch).toHaveBeenCalledWith(
    "/api/server-update/check",
    expect.objectContaining({ method: "POST" }),
  );
  expect(mocks.fetch.mock.calls[0][1]?.body).toBeUndefined();
});
