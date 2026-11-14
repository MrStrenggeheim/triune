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
