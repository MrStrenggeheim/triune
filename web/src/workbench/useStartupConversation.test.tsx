// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as sessions from "@/lib/sessionsApi";
import type { Session } from "@/lib/types";
import { writeStartupDestination } from "@/lib/startupPreferences";
import { useStartupConversation } from "./useStartupConversation";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function options() {
  return {
    active: true,
    href: "/",
    entryKey: "initial",
    ownerId: "saved-owner",
    navigate: vi.fn(),
    onError: vi.fn(),
  };
}
it("continues the saved layout owner by default only once", async () => {
  const fetch = vi.spyOn(sessions, "getSessionSlim").mockResolvedValue({} as Session);
  const props = options();
  const { result, rerender } = renderHook(useStartupConversation, { initialProps: props });
  expect(result.current).toBe(true);
  await waitFor(() =>
    expect(props.navigate).toHaveBeenCalledWith("/c/saved-owner", { replace: true }),
  );
  rerender({ ...props, href: "/c/saved-owner", entryKey: "continued" });
  rerender({ ...props, href: "/", entryKey: "new-chat" });
  expect(result.current).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(props.navigate).toHaveBeenCalledTimes(1);
});
it.each([
  "/c/explicit?message=exact",
  "/?view=workbench",
  "/?draft=saved",
  "/settings",
  "/#reference",
])("preserves explicit launch %s", (href) => {
  const fetch = vi.spyOn(sessions, "getSessionSlim");
  const { result } = renderHook(useStartupConversation, { initialProps: { ...options(), href } });
  expect(result.current).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps New chat preference and fresh scopes on the landing page", () => {
  const fetch = vi.spyOn(sessions, "getSessionSlim");
  writeStartupDestination("new");
  const first = renderHook(useStartupConversation, { initialProps: options() });
  expect(first.result.current).toBe(false);
  first.unmount();
  writeStartupDestination("continue");
  const fresh = renderHook(useStartupConversation, {
    initialProps: { ...options(), ownerId: null },
  });
  expect(fresh.result.current).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([403, 404, 410, 500])(
  "falls back without looping when saved access fails (%s)",
  async (status) => {
    vi.spyOn(sessions, "getSessionSlim").mockRejectedValue(
      new sessions.ApiError("Unavailable", status, null),
    );
    const props = options();
    const { result } = renderHook(useStartupConversation, { initialProps: props });
    await waitFor(() => expect(result.current).toBe(false));
    expect(props.navigate).not.toHaveBeenCalled();
    expect(props.onError).toHaveBeenCalledTimes(status === 500 ? 1 : 0);
  },
);
it.each(["/c/new-choice", "/"])(
  "newer navigation wins over pending restoration to %s",
  async (href) => {
    let complete!: (session: Session) => void;
    const fetch = vi.spyOn(sessions, "getSessionSlim").mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const props = options();
    const { result, rerender } = renderHook(useStartupConversation, { initialProps: props });
    const signal = fetch.mock.calls[0][1]?.signal;
    rerender({ ...props, href, entryKey: "deliberate-choice" });
    await act(async () => complete({} as Session));
    expect(signal?.aborted).toBe(true);
    expect(result.current).toBe(false);
    expect(props.navigate).not.toHaveBeenCalled();
  },
);
it("remains usable with StrictMode effect replay", async () => {
  vi.spyOn(sessions, "getSessionSlim").mockImplementation(async (_id, opts) => {
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return {} as Session;
  });
  const props = options();
  renderHook(() => useStartupConversation(props), {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });
  await waitFor(() => expect(props.navigate).toHaveBeenCalledTimes(1));
});
