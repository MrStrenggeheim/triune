// Modified for Triune.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import { useChatActivity } from "./useChatActivity";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
const fetch = vi.mocked(authenticatedFetch);
let client: QueryClient;
const payload = (id = "shell") => ({
  data: [
    {
      id,
      kind: "terminal",
      session_id: "source",
      terminal_id: "term",
      name: "bash",
      state: "idle",
      owner_kind: "chat",
      owner_id: "source",
    },
  ],
  coverage: {
    terminals: "captured",
    history: "bounded",
    output: "bounded_snapshots",
    non_tty_commands: "unavailable",
    native_vendor_shells: "unknown",
    max_entries: 128,
    max_output_bytes: 8192,
  },
  warning: "Older output was not retained.",
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  fetch.mockReset().mockImplementation(async () => Response.json(payload()));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

it.each([null, "", "temp:pending"])("does not fetch activity for %s", (id) => {
  const { result } = renderHook(() => useChatActivity(id), { wrapper });
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current.data).toBeUndefined();
});

it("fetches the selected chat with cancellation and preserves coverage and resource identity", async () => {
  const { result } = renderHook(() => useChatActivity("chat/with spaces"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledWith("/v1/sessions/chat%2Fwith%20spaces/activity", {
    signal: expect.any(AbortSignal),
  });
  expect(result.current.data).toEqual(payload());
});

it.each([403, 404, 503])("surfaces HTTP %s without retries or invented history", async (status) => {
  fetch.mockResolvedValue(Response.json({ detail: "Activity is unavailable" }, { status }));
  const { result } = renderHook(() => useChatActivity("chat"), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error?.message).toBe("Activity is unavailable");
  expect(result.current.data).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("clears old rows on a chat switch and cancels superseded requests", async () => {
  const { result, rerender } = renderHook(({ id }) => useChatActivity(id), {
    wrapper,
    initialProps: { id: "a" },
  });
  await waitFor(() => expect(result.current.data).toBeDefined());
  let finish!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  rerender({ id: "b" });
  expect(result.current.data).toBeUndefined();
  const signal = fetch.mock.calls[1][1]?.signal;
  fetch.mockResolvedValueOnce(Response.json(payload("c-shell")));
  rerender({ id: "c" });
  expect(signal?.aborted).toBe(true);
  await waitFor(() => expect(result.current.data?.data[0].id).toBe("c-shell"));
  await act(async () => {
    finish(Response.json(payload("late-b-shell")));
  });
  expect(result.current.data?.data[0].id).toBe("c-shell");
});

it("retains cached rows on refresh failure", async () => {
  const { result } = renderHook(() => useChatActivity("chat"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  fetch.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await result.current.refetch();
  });
  expect(result.current.data).toEqual(payload());
  await waitFor(() => expect(result.current.error?.message).toBe("offline"));
});

it("polls for newly recorded usage even when initially empty and stops on unmount", async () => {
  vi.useFakeTimers();
  fetch.mockResolvedValueOnce(Response.json({ data: [], coverage: "complete" }));
  const { result, unmount } = renderHook(() => useChatActivity("chat"), { wrapper });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(result.current.data?.data).toEqual([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(result.current.data?.data[0].id).toBe("shell");
  expect(fetch).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("pauses a retained hidden view for fifteen seconds and resumes its cached activity", async () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(
    ({ active }) => useChatActivity("chat", { enabled: active }),
    { initialProps: { active: false }, wrapper },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(fetch).not.toHaveBeenCalled();
  rerender({ active: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const cached = result.current.data;
  expect(cached).toEqual(payload());
  rerender({ active: false });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["chat-activity", "chat"] });
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.current.data).toBe(cached);
  rerender({ active: true });
  expect(result.current.data).toBe(cached);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
