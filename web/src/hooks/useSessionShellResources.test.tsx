// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { shellState } from "@/lib/shellState";
import { authenticatedFetch } from "@/lib/identity";
import {
  useSessionShellResources,
  shellResourcePath,
  shellStopRequest,
  mergeShellResources,
  shellResourceMatchesActivity,
  type SessionShellResource,
} from "./useSessionShellResources";

vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
  getCurrentUserId: () => "shell-test",
}));
const fetch = vi.mocked(authenticatedFetch);
let client: QueryClient;
const resource = (id = "one", session = "chat"): SessionShellResource => ({
  source: "codex_native",
  session_id: session,
  resource_id: id,
  status: "running",
  command: "same command",
  output_preview: `output ${id}`,
  can_open: true,
  can_stop: true,
  resource_url: `/v1/sessions/${session}/resources/shells/codex_native/${id}`,
  stop_url: `/v1/sessions/${session}/resources/shells/codex_native/${id}/stop`,
  stop_method: "POST",
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  focusManager.setFocused(true);
  fetch.mockReset().mockResolvedValue(Response.json({ data: [resource()] }));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

it.each([null, undefined, "", "temp:pending"])("never queries uncaptured session %s", (id) => {
  renderHook(() => useSessionShellResources(id), { wrapper });
  expect(fetch).not.toHaveBeenCalled();
});

it("shares one session query between consumers and cancels only when all observers hide", async () => {
  const { result, rerender } = renderHook(
    ({ first, second }) => [
      useSessionShellResources("chat", { enabled: first }),
      useSessionShellResources("chat", { enabled: second }),
    ],
    { initialProps: { first: true, second: true }, wrapper },
  );
  await waitFor(() => expect(result.current[0].isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.current[0].data).toBe(result.current[1].data);
  let finish!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    void result.current[0].refetch();
  });
  const signal = fetch.mock.calls[1][1]?.signal;
  rerender({ first: false, second: true });
  expect(signal?.aborted).toBe(false);
  rerender({ first: false, second: false });
  await waitFor(() => expect(signal?.aborted).toBe(true));
  await act(async () => finish(Response.json({ data: [resource("late")] })));
  expect(result.current[0].data?.data[0].resource_id).toBe("one");
});

it("retains rows through refresh failure and isolates a switched session from late responses", async () => {
  const { result, rerender } = renderHook(({ session }) => useSessionShellResources(session), {
    initialProps: { session: "chat" },
    wrapper,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const cached = result.current.data;
  fetch.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await result.current.refetch();
  });
  expect(result.current.data).toBe(cached);
  await waitFor(() => expect(result.current.error?.message).toBe("offline"));
  let finish!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  rerender({ session: "next" });
  expect(result.current.data).toBeUndefined();
  const signal = fetch.mock.calls.at(-1)?.[1]?.signal;
  fetch.mockResolvedValueOnce(Response.json({ data: [resource("final", "last")] }));
  rerender({ session: "last" });
  expect(signal?.aborted).toBe(true);
  await waitFor(() => expect(result.current.data?.data[0].resource_id).toBe("final"));
  await act(async () => finish(Response.json({ data: [resource("late", "next")] })));
  expect(result.current.data?.data[0].resource_id).toBe("final");
});

it("polls only while a consumer is visible and resumes its cached rows", async () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(
    ({ active }) => useSessionShellResources("chat", { enabled: active }),
    { initialProps: { active: false }, wrapper },
  );
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(fetch).not.toHaveBeenCalled();
  rerender({ active: true });
  await act(async () => vi.advanceTimersByTimeAsync(10));
  const cached = result.current.data;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(fetch).toHaveBeenCalledTimes(2);
  rerender({ active: false });
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.current.data).toEqual(cached);
  rerender({ active: true });
  expect(result.current.data).toEqual(cached);
  await act(async () => vi.advanceTimersByTimeAsync(10));
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([
  { session_id: "other" },
  { source: "unknown" },
  { resource_id: null },
  { resource_url: "https://other.invalid/resource" },
  { output: 12 },
])("rejects malformed or cross-session inventory %j", async (override) => {
  fetch.mockResolvedValue(Response.json({ data: [{ ...resource(), ...override }] }));
  const { result } = renderHook(() => useSessionShellResources("chat"), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("encodes captured identity and rejects arbitrary Stop routes or methods", () => {
  expect(shellResourcePath("chat/雪", { source: "codex_native", resource_id: "item/a !" })).toBe(
    "/v1/sessions/chat%2F%E9%9B%AA/resources/shells/codex_native/item%2Fa%20%21",
  );
  expect(shellStopRequest("chat", resource())).toEqual({
    url: "/v1/sessions/chat/resources/shells/codex_native/one/stop",
    method: "POST",
  });
  for (const override of [
    { stop_url: "/v1/sessions/other/resources/shells/codex_native/one/stop" },
    { stop_method: "DELETE" as const },
    { status: "completed" },
    { can_stop: false },
  ])
    expect(shellStopRequest("chat", { ...resource(), ...override })).toBeUndefined();
});

it.each([403, 404, 503])(
  "surfaces inventory HTTP %s without retries or guessed capabilities",
  async (status) => {
    fetch.mockResolvedValue(Response.json({ detail: "Shell service unavailable" }, { status }));
    const { result } = renderHook(() => useSessionShellResources("chat"), { wrapper });
    await waitFor(() => expect(result.current.error?.message).toBe("Shell service unavailable"));
    expect(result.current.data).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("merges by stable resource identity without matching equal command text or trusting stored capabilities", () => {
  const one = resource();
  const two = resource("two");
  const rows = mergeShellResources(
    [
      { ...one, output_preview: "stale" },
      { command: "same command", can_stop: true },
    ],
    [two, one],
    2,
    true,
  );
  expect(rows.map((row) => row.output_preview)).toEqual(["output one", undefined]);
  expect(rows.map((row) => row.can_stop)).toEqual([true, false]);
  expect(mergeShellResources([one], [one], 1, false)[0].can_stop).toBe(false);
  expect(mergeShellResources([{ ...one, status: "completed" }], [one], 1, true)[0]).toMatchObject({
    status: "completed",
    can_stop: false,
  });
  expect(mergeShellResources([], [one, two], 1, true)).toHaveLength(1);
  expect(mergeShellResources([one], [one], 0, true)).toEqual([]);
});

it("deduplicates explicit call/known activity identities without equating commands or sessions", () => {
  const entry = {
    id: "command_known_digest",
    session_id: "chat",
    kind: "command" as const,
    source: "codex_native" as const,
    source_call_id: "one",
  };
  expect(shellResourceMatchesActivity(resource(), entry, "chat")).toBe(true);
  expect(shellResourceMatchesActivity(resource("two"), entry, "chat")).toBe(false);
  expect(
    shellResourceMatchesActivity(resource(), { ...entry, source: "claude_native" }, "chat"),
  ).toBe(false);
  expect(shellResourceMatchesActivity(resource(), { ...entry, session_id: "other" }, "chat")).toBe(
    false,
  );
  expect(
    shellResourceMatchesActivity(
      { ...resource(), activity_id: entry.id },
      { id: entry.id, kind: "command", session_id: "chat" },
      "chat",
    ),
  ).toBe(true);
  expect(
    shellResourceMatchesActivity(
      resource(),
      { id: entry.id, kind: "command", session_id: "chat" },
      "chat",
    ),
  ).toBe(false);
});

it.each([
  ["completed", "stopped", -1, "Stopped", "stopped"],
  ["stopped", "failed", -1, "Stopped", "stopped"],
  ["completed", "failed", 7, "Failed", "failed"],
  ["completed", "running", undefined, "Ended", "completed"],
  ["stopped", "running", undefined, "Stopped", "stopped"],
] as const)(
  "preserves outcome for reported %s and observed %s without resurrecting Stop",
  (reported, observed, exit_code, label, status) => {
    const [merged] = mergeShellResources(
      [{ ...resource(), status: reported }],
      [{ ...resource(), status: observed, exit_code }],
      2,
      true,
    );
    expect(merged).toMatchObject({ status, can_stop: false });
    expect(shellState({ status: merged.status, exitCode: merged.exit_code }).label).toBe(label);
    if (exit_code !== undefined) expect(merged.exit_code).toBe(exit_code);
  },
);

it("retains confirmed exit evidence across a late live update and isolates a reused terminal slot", () => {
  const old = {
    ...resource("launch-old"),
    terminal_id: "same-slot",
    status: "exited",
    exit_code: 0,
  };
  const fresh = { ...resource("launch-new"), terminal_id: "same-slot" };
  const rows = mergeShellResources(
    [old],
    [{ ...old, status: "running", exit_code: null }, fresh],
    3,
    true,
  );
  expect(rows).toMatchObject([
    { resource_id: "launch-old", status: "exited", exit_code: 0, can_stop: false },
    { resource_id: "launch-new", status: "running", can_stop: true },
  ]);
});
