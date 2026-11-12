import type { ReactNode } from "react";
import type * as HostModule from "@/lib/host";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionOrchestrationPreference } from "@/hooks/useSessionOrchestrationPreference";
import { SessionOrchestrationSettings } from "./SessionOrchestrationSettings";

const mocks = vi.hoisted(() => ({
  account: "alice",
  server: "server-a",
  fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  fetcher: undefined as undefined | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock("@/hooks/useViewerId", () => ({ useViewerId: () => mocks.account }));
vi.mock("@/lib/identity", () => ({
  getCurrentUserId: () => mocks.account,
  authenticatedFetch: mocks.fetch,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof HostModule>()),
  getOmnigentServerIdentity: () => mocks.server,
  getOmnigentHostConfig: () => ({ fetcher: mocks.fetcher }),
}));

const path = "/v1/preferences/session-orchestration";
const key = (server = "server-a", account = "alice") =>
  ["session-orchestration-preference", server, account] as const;
const preference = (enabled = true, serverEnabled = true) => ({
  enabled,
  server_enabled: serverEnabled,
});
const response = (enabled = true, serverEnabled = true) =>
  Response.json(preference(enabled, serverEnabled));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
function cache() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
const toggle = () => screen.getByRole("switch", { name: "Agent communication" });

beforeEach(() => {
  mocks.account = "alice";
  mocks.server = "server-a";
  mocks.fetcher = undefined;
  mocks.fetch.mockReset().mockImplementation(async () => response());
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

it("loads the default-on personal preference with authentication and cancellation", async () => {
  const pending = deferred<Response>();
  mocks.fetch.mockReturnValueOnce(pending.promise);
  render(<SessionOrchestrationSettings />, { wrapper: cache().wrapper });
  expect(toggle()).toBeChecked();
  expect(toggle()).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await act(async () => pending.resolve(response()));
  await waitFor(() => expect(toggle()).toBeEnabled());
  expect(toggle()).toBeChecked();
  expect(mocks.fetch).toHaveBeenCalledWith(path, {
    signal: expect.any(AbortSignal),
    headers: expect.any(Headers),
    cache: "no-store",
  });
  expect(new Headers(mocks.fetch.mock.calls[0][1]?.headers).get("X-Forwarded-Email")).toBe("alice");
  expect(screen.getByText(/Allow your agents/)).toHaveTextContent(
    "Allow your agents to message other chats and create independent worker chats. Changes take effect immediately. Ordinary subagents are unaffected.",
  );
});

it("saves off and on through PUT and reads the stored preference after each reload", async () => {
  let stored = true;
  mocks.fetch.mockImplementation(async (_path, init) => {
    if (init?.method === "PUT") stored = JSON.parse(String(init.body)).enabled;
    return response(stored);
  });
  async function saveAndReload(enabled: boolean) {
    const view = render(<SessionOrchestrationSettings />, { wrapper: cache().wrapper });
    await waitFor(() => expect(toggle()).toBeEnabled());
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", String(enabled)));
    expect(stored).toBe(enabled);
    const [, init] = mocks.fetch.mock.calls.findLast(([, request]) => request?.method === "PUT")!;
    expect(init?.body).toBe(JSON.stringify({ enabled }));
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    view.unmount();
    const reloaded = render(<SessionOrchestrationSettings />, { wrapper: cache().wrapper });
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(toggle()).toHaveAttribute("aria-checked", String(enabled));
    reloaded.unmount();
  }
  await saveAndReload(false);
  await saveAndReload(true);
});

it("keeps the confirmed value and disables the switch until a save succeeds", async () => {
  const pending = deferred<Response>();
  render(<SessionOrchestrationSettings />, { wrapper: cache().wrapper });
  await waitFor(() => expect(toggle()).toBeEnabled());
  mocks.fetch.mockReturnValueOnce(pending.promise);
  fireEvent.click(toggle());
  await waitFor(() => expect(toggle()).toBeDisabled());
  expect(toggle()).toBeChecked();
  expect(screen.getByRole("status")).toHaveTextContent("Saving");
  await act(async () => pending.resolve(response(false)));
  await waitFor(() => expect(toggle()).not.toBeChecked());
  expect(toggle()).toBeEnabled();
});

it.each(["http", "network", "invalid"])(
  "surfaces a %s save failure without displaying an unsaved value",
  async (failure) => {
    const { client, wrapper } = cache();
    render(<SessionOrchestrationSettings />, { wrapper });
    await waitFor(() => expect(toggle()).toBeEnabled());
    if (failure === "network") mocks.fetch.mockRejectedValueOnce(new Error("Connection lost"));
    else {
      mocks.fetch.mockResolvedValueOnce(
        failure === "http"
          ? Response.json({ error: { message: "Preference store unavailable" } }, { status: 503 })
          : Response.json({ enabled: false }),
      );
    }
    fireEvent.click(toggle());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      failure === "http"
        ? "Preference store unavailable"
        : failure === "network"
          ? "Connection lost"
          : "Invalid agent communication preference response",
    );
    expect(toggle()).toBeChecked();
    expect(toggle()).toBeEnabled();
    expect(client.getQueryData(key())).toEqual(preference());
    expect(screen.queryByText(/saved/i)).not.toBeInTheDocument();
  },
);

it("surfaces a real load failure and allows retry", async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ detail: "Access denied" }, { status: 403 }));
  render(<SessionOrchestrationSettings />, { wrapper: cache().wrapper });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load agent communication: Access denied",
  );
  expect(toggle()).toBeDisabled();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(toggle()).toBeEnabled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([true, false])(
  "shows stored enabled=%s while the administrator disables access",
  async (enabled) => {
    mocks.fetch.mockResolvedValue(response(enabled, false));
    render(<SessionOrchestrationSettings />, { wrapper: cache().wrapper });
    expect(await screen.findByText(/Disabled by your server administrator/)).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-checked", String(enabled));
    expect(toggle()).toBeDisabled();
    fireEvent.click(toggle());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  },
);

it("hides the unavailable setting on older servers returning GET 404", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ detail: "Not Found" }, { status: 404 }));
  const { client, wrapper } = cache();
  render(<SessionOrchestrationSettings />, { wrapper });
  await waitFor(() => expect(client.getQueryData(key())).toBeNull());
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByTestId("settings-group-agents")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("cancels a stale GET before PUT so its late response cannot undo the save", async () => {
  const { client, wrapper } = cache();
  const { result } = renderHook(useSessionOrchestrationPreference, { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const stale = deferred<Response>();
  mocks.fetch.mockReturnValueOnce(stale.promise);
  let refresh!: Promise<unknown>;
  act(() => {
    refresh = result.current.refetch();
  });
  const signal = mocks.fetch.mock.calls[1][1]?.signal;
  mocks.fetch.mockImplementationOnce(async () => {
    expect(signal?.aborted).toBe(true);
    return response(false);
  });
  act(() => result.current.save(false));
  await waitFor(() => expect(result.current.data?.enabled).toBe(false));
  await act(async () => {
    stale.resolve(response(true));
    await refresh;
  });
  expect(result.current.data).toEqual(preference(false));
  expect(client.getQueryData(key())).toEqual(preference(false));
});

it.each(["server", "account"])(
  "keeps pending saves bound to their original %s and transport",
  async (scope) => {
    const originalFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(
      async (_path, init) => response(init?.method !== "PUT"),
    );
    const nextFetch = vi.fn(async () => response());
    mocks.fetcher = originalFetch;
    const { client, wrapper } = cache();
    const { result, rerender } = renderHook(useSessionOrchestrationPreference, { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cancellation = deferred<void>();
    const cancelQueries = client.cancelQueries.bind(client);
    vi.spyOn(client, "cancelQueries").mockImplementationOnce(async (filters) => {
      await cancelQueries(filters);
      await cancellation.promise;
    });
    act(() => result.current.save(false));
    await waitFor(() => expect(result.current.isSaving).toBe(true));
    if (scope === "server") mocks.server = "server-b";
    else mocks.account = "bob";
    mocks.fetcher = nextFetch;
    rerender();
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual(preference()));
    expect(result.current.isSaving).toBe(false);
    await act(async () => cancellation.resolve());
    await waitFor(() => expect(client.getQueryData(key())).toEqual(preference(false)));
    expect(originalFetch).toHaveBeenLastCalledWith(path, {
      method: "PUT",
      headers: expect.any(Headers),
      body: JSON.stringify({ enabled: false }),
      cache: "no-store",
    });
    const init = originalFetch.mock.calls.at(-1)?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-Forwarded-Email")).toBe("alice");
    expect(nextFetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key(mocks.server, mocks.account))).toEqual(preference());
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);

it("rejects a standalone save superseded during cancellation before calling mutable auth", async () => {
  const { client, wrapper } = cache();
  const { result, rerender } = renderHook(useSessionOrchestrationPreference, { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const cancellation = deferred<void>();
  vi.spyOn(client, "cancelQueries").mockImplementationOnce(() => cancellation.promise);
  act(() => result.current.save(false));
  await waitFor(() => expect(result.current.isSaving).toBe(true));
  mocks.server = "server-b";
  rerender();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  await act(async () => cancellation.resolve());
  await waitFor(() => expect(client.getMutationCache().getAll()[0].state.status).toBe("error"));
  expect(mocks.fetch.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true);
  expect(client.getQueryData(key())).toEqual(preference());
  expect(client.getQueryData(key("server-b"))).toEqual(preference());
  expect(result.current.saveError).toBeNull();
});
