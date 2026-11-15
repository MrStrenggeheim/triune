// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import { useRuntimeNotices } from "./useRuntimeNotices";

vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
  getCurrentUserId: () => "notices-user",
}));
const fetch = vi.mocked(authenticatedFetch);
let client: QueryClient;
const notice = {
  id: "quota-window",
  revision: "warning-1",
  title: "Usage limit approaching",
  message: "Usage is 92%.",
  provider: "Codex",
  severity: "warning",
  created_at: 100,
};
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  fetch.mockReset().mockImplementation(async () => Response.json({ data: [notice] }));
});
afterEach(() => {
  cleanup();
  client.clear();
});

it("never requests notices for an uncaptured or hidden conversation", () => {
  const { rerender } = renderHook(({ id, active }) => useRuntimeNotices(id, active), {
    initialProps: { id: "temp:pending", active: true },
    wrapper,
  });
  rerender({ id: "hidden", active: false });
  expect(fetch).not.toHaveBeenCalled();
});

it("dismisses only the observed revision without sending a native response", async () => {
  const { result } = renderHook(() => useRuntimeNotices("dismiss-chat", true), { wrapper });
  await waitFor(() => expect(result.current.notices).toHaveLength(1));
  act(() => result.current.dismiss(result.current.notices[0]));
  await waitFor(() => expect(result.current.notices).toHaveLength(0));
  await act(async () => {
    await result.current.refetch();
  });
  expect(result.current.notices).toHaveLength(0);
  fetch.mockResolvedValueOnce(
    Response.json({ data: [{ ...notice, revision: "error-2", severity: "error" }] }),
  );
  await act(async () => {
    await result.current.refetch();
  });
  expect(result.current.notices).toHaveLength(1);
  expect(fetch.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
});

it("isolates conversations and refuses malformed notice data", async () => {
  const { result, rerender } = renderHook(({ id }) => useRuntimeNotices(id, true), {
    initialProps: { id: "first-notices" },
    wrapper,
  });
  await waitFor(() => expect(result.current.notices).toHaveLength(1));
  act(() => result.current.dismiss(result.current.notices[0]));
  rerender({ id: "second-notices" });
  await waitFor(() => expect(result.current.notices).toHaveLength(1));
  fetch.mockResolvedValueOnce(Response.json({ data: [{ ...notice, title: { private: "raw" } }] }));
  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() => expect(result.current.error?.message).toBe("Invalid agent notice."));
  expect(result.current.notices[0].title).toBe(notice.title);
});

it("keeps healthy quotas available after a warning is dismissed and preserves typed source fields", async () => {
  const quota = {
    id: "quota-a",
    provider: "codex",
    window: "primary",
    used_percent: 25,
    reset_at: 200,
    window_minutes: 300,
    status: "allowed",
    observed_at: 100,
    source_kind: "native",
  };
  fetch.mockResolvedValue(
    Response.json({
      data: [
        {
          ...notice,
          category: "quota",
          source_kind: "native",
          native_subtype: "rate_limit",
          blocking: null,
          observed_at: 100,
        },
        { ...notice, id: "healthy", category: "quota", severity: "info" },
      ],
      quotas: [quota],
    }),
  );
  const { result } = renderHook(() => useRuntimeNotices("healthy-usage-chat", true), { wrapper });
  await waitFor(() => expect(result.current.notices).toHaveLength(1));
  expect(result.current.notices[0]).toMatchObject({
    source_kind: "native",
    native_subtype: "rate_limit",
    blocking: null,
    observed_at: 100,
  });
  expect(result.current.quotas).toEqual([quota]);
  act(() => result.current.dismiss(result.current.notices[0]));
  await waitFor(() => expect(result.current.notices).toHaveLength(0));
  expect(result.current.quotas).toEqual([quota]);
});

it("hides cached notices and quota observations after access is denied", async () => {
  const { result } = renderHook(() => useRuntimeNotices("revoked-chat", true), { wrapper });
  await waitFor(() => expect(result.current.notices).toHaveLength(1));
  fetch.mockResolvedValueOnce(
    Response.json({ error: { code: "forbidden", message: "Access denied" } }, { status: 403 }),
  );
  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() => expect(result.current.accessDenied).toBe(true));
  expect(result.current.notices).toHaveLength(0);
  expect(result.current.quotas).toHaveLength(0);
});

it("pauses observation polling when a retained conversation becomes inactive", async () => {
  const { result, rerender } = renderHook(({ active }) => useRuntimeNotices("pause-chat", active), {
    initialProps: { active: true },
    wrapper,
  });
  await waitFor(() => expect(result.current.notices).toHaveLength(1));
  vi.useFakeTimers();
  try {
    rerender({ active: false });
    const calls = fetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetch).toHaveBeenCalledTimes(calls);
  } finally {
    vi.useRealTimers();
  }
});
