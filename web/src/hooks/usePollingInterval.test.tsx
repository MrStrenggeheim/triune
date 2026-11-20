// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionUpdatesSocket } from "@/lib/sessionUpdatesSocket";
import { pollingInterval, usePageVisible, usePollingInterval } from "./usePollingInterval";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  cleanup();
  setVisibility("visible");
  vi.restoreAllMocks();
});

describe("pollingInterval", () => {
  const shown = { pageVisible: true, socketConnected: false };
  it.each([
    ["visible and active", { active: true, intervalMs: 15_000 }, shown, 15_000],
    ["inactive owner", { active: false, intervalMs: 15_000 }, shown, false],
    ["hidden page", { active: true, intervalMs: 15_000 }, { ...shown, pageVisible: false }, false],
    [
      "pushed data while connected",
      { active: true, intervalMs: 30_000, pushed: true },
      { ...shown, socketConnected: true },
      false,
    ],
    [
      "pushed data while disconnected",
      { active: true, intervalMs: 30_000, pushed: true },
      shown,
      30_000,
    ],
    [
      "unpushed data while connected",
      { active: true, intervalMs: 15_000 },
      { ...shown, socketConnected: true },
      15_000,
    ],
  ])("%s", (_case, policy, environment, expected) => {
    expect(pollingInterval(policy, environment)).toBe(expected);
  });
});

describe("usePollingInterval", () => {
  it("follows page visibility and the updates socket connection", () => {
    let connected = false;
    const listeners = new Set<() => void>();
    vi.spyOn(sessionUpdatesSocket, "isConnected").mockImplementation(() => connected);
    vi.spyOn(sessionUpdatesSocket, "subscribeStatus").mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const { result } = renderHook(() => ({
      pushed: usePollingInterval({ active: true, intervalMs: 30_000, pushed: true }),
      visible: usePageVisible(),
    }));
    expect(result.current).toEqual({ pushed: 30_000, visible: true });
    act(() => {
      connected = true;
      for (const listener of listeners) listener();
    });
    expect(result.current.pushed).toBe(false);
    act(() => {
      connected = false;
      for (const listener of listeners) listener();
      setVisibility("hidden");
    });
    expect(result.current).toEqual({ pushed: false, visible: false });
    act(() => setVisibility("visible"));
    expect(result.current).toEqual({ pushed: 30_000, visible: true });
  });
});
