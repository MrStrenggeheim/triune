// Modified for Triune.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authenticatedFetch } from "@/lib/identity";
import {
  CHILD_LIST_REFETCH_MS,
  childSessionsQueryKey,
  fetchChildSessions,
  scheduleChildListRefetch,
  useChildSessions,
  useChildSessionTree,
  useDescendantSession,
} from "./useChildSessions";

vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
}));

function wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
});
afterEach(cleanup);

describe("useChildSessions", () => {
  it("reads up to two hundred children per request and follows every page", async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "newer", agent_name: "James", created_at: 100, updated_at: 300 }],
          has_more: true,
          last_id: "newer",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "older", task_summary: "Still running", busy: true, child_count: 0 }],
          has_more: false,
        }),
      );
    const children = await fetchChildSessions("root");
    expect(children.map((child) => child.id)).toEqual(["newer", "older"]);
    expect(children[0]).toMatchObject({
      agent_name: "James",
      created_at: 100,
      updated_at: 300,
      child_count: null,
    });
    expect(children[1]!.child_count).toBe(0);
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      1,
      "/v1/sessions/root/child_sessions?limit=200",
      {
        signal: undefined,
      },
    );
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      "/v1/sessions/root/child_sessions?limit=200&after=newer",
      { signal: undefined },
    );
  });

  it("rejects a repeated pagination cursor without returning a partial list", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async () =>
      Response.json({ data: [], has_more: true, last_id: "same" }),
    );
    await expect(fetchChildSessions("root")).rejects.toThrow("invalid cursor");
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });
  it("shares one refresh for missed lifecycle changes and preserves a newer live update", async () => {
    const client = new QueryClient();
    const key = childSessionsQueryKey("parent");
    const stale = { id: "child", busy: true, current_task_status: "in_progress" };
    const done = { ...stale, busy: false, current_task_status: "completed" };
    client.setQueryData(key, [stale]);
    let resolve!: (value: Response) => void;
    vi.mocked(authenticatedFetch).mockImplementation(
      () =>
        new Promise((accept) => {
          resolve = accept;
        }),
    );
    const provider = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    vi.useFakeTimers();
    try {
      const { result, rerender, unmount } = renderHook(
        ({ dispatchId, enabled }) => [
          useChildSessions("parent", {
            enabled,
            reconcile: true,
            unresolvedChild: "child",
            dispatchId,
          }),
          useChildSessions("parent", { enabled, reconcile: true }),
        ],
        { wrapper: provider, initialProps: { dispatchId: "spawn", enabled: true } },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(authenticatedFetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        client.setQueryData(key, [done]);
        resolve(Response.json({ data: [stale] }));
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(result.current.map((q) => q.children[0]?.current_task_status)).toEqual([
        "completed",
        "completed",
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(authenticatedFetch).toHaveBeenCalledTimes(1);

      rerender({ dispatchId: "steer", enabled: true });
      expect(authenticatedFetch).toHaveBeenCalledTimes(2);
      expect(result.current[0]!.children[0]!.busy).toBe(false);
      await act(async () => {
        resolve(Response.json({ data: [stale] }));
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(result.current[0]!.children[0]!.busy).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(authenticatedFetch).toHaveBeenCalledTimes(3);
      await act(async () => {
        resolve(new Response(null, { status: 503 }));
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(result.current[0]!.children[0]!.statusUnavailable).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(authenticatedFetch).toHaveBeenCalledTimes(4);
      await act(async () => {
        resolve(Response.json({ data: [done] }));
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(result.current[0]!.children[0]!.statusUnavailable).toBeUndefined();
      expect(result.current[0]!.children[0]!.current_task_status).toBe("completed");
      rerender({ dispatchId: "steer", enabled: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(authenticatedFetch).toHaveBeenCalledTimes(4);
      unmount();
    } finally {
      client.clear();
      vi.useRealTimers();
    }
  });

  it("does not fetch child sessions for a provisional conversation", () => {
    const { result } = renderHook(() => useChildSessions("temp:pending-create"), { wrapper });

    expect(result.current.children).toEqual([]);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});

describe("useChildSessionTree", () => {
  it("collects three levels and disables every query when retained out of view", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const treeWrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const descendants: Record<string, string> = {
      root: "child",
      child: "grandchild",
      grandchild: "great-grandchild",
    };
    vi.mocked(authenticatedFetch).mockImplementation(async (path) => {
      const id = String(path).split("/")[3]!;
      return Response.json({
        data: descendants[id] ? [{ id: descendants[id] }] : [],
        has_more: false,
      });
    });
    const { result, rerender, unmount } = renderHook(
      ({ active }) => useChildSessionTree("root", active),
      { initialProps: { active: false }, wrapper: treeWrapper },
    );
    expect(authenticatedFetch).not.toHaveBeenCalled();
    rerender({ active: true });
    await waitFor(() =>
      expect(result.current.children.map((child) => child.id)).toEqual([
        "child",
        "grandchild",
        "great-grandchild",
      ]),
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    rerender({ active: false });
    await act(async () => {
      await client.invalidateQueries();
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    expect(result.current.children).toHaveLength(3);
    unmount();
    client.clear();
  });
});

describe("useChildSessionTree lazy levels", () => {
  it("loads nested lists only for possible parents and leaves them to pushes", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const treeWrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const lists: Record<string, object[]> = {
      root: [
        { id: "leaf", child_count: 0 },
        { id: "parent", child_count: 1 },
        { id: "unknown", child_count: null },
      ],
      parent: [
        { id: "busy-grandchild", busy: true, current_task_status: "in_progress", child_count: 0 },
      ],
    };
    vi.mocked(authenticatedFetch).mockImplementation(async (path) => {
      const id = String(path).split("/")[3]!;
      return Response.json({ data: lists[id] ?? [], has_more: false });
    });
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useChildSessionTree("root", true), {
        wrapper: treeWrapper,
      });
      // One tick per tree level.
      for (let level = 0; level < 3; level++) {
        // oxlint-disable-next-line no-await-in-loop
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
      }
      expect(result.current.children.map((child) => child.id)).toEqual([
        "leaf",
        "parent",
        "unknown",
        "busy-grandchild",
      ]);
      const fetched = vi
        .mocked(authenticatedFetch)
        .mock.calls.map(([path]) => String(path).split("/")[3]);
      expect(fetched.sort()).toEqual(["parent", "root", "unknown"]);
      // A busy grandchild does not start the five-second clock below the root.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(authenticatedFetch).toHaveBeenCalledTimes(3);
      unmount();
    } finally {
      client.clear();
      vi.useRealTimers();
    }
  });
});

describe("scheduleChildListRefetch", () => {
  it("waits for an in-flight read to settle instead of folding into or aborting it", async () => {
    const client = new QueryClient();
    const key = childSessionsQueryKey("parent");
    let finish!: (rows: object[]) => void;
    const signals: AbortSignal[] = [];
    vi.useFakeTimers();
    try {
      const first = client.fetchQuery({
        queryKey: key,
        queryFn: ({ signal }) => {
          signals.push(signal);
          return new Promise<object[]>((resolve) => {
            finish = resolve;
          });
        },
      });
      scheduleChildListRefetch(client, "parent");
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      finish([]);
      await first;
      await vi.advanceTimersByTimeAsync(CHILD_LIST_REFETCH_MS);
      expect(signals[0]!.aborted).toBe(false);
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      client.clear();
      vi.useRealTimers();
    }
  });
});

describe("useDescendantSession", () => {
  it("fetches the direct-child list when it is not cached", async () => {
    // WHY: a mirrored card can mount before anything loaded the ancestor's
    // child list; the lookup must fetch it rather than stay unlabeled.
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "conv_child",
              title: "researcher:auth",
              task_summary: "Investigate auth flow",
              tool: "researcher",
              session_name: "auth",
              current_task_status: "in_progress",
              busy: true,
            },
          ],
        }),
      ),
    );
    const { result } = renderHook(() => useDescendantSession("conv_parent", "conv_child"), {
      wrapper,
    });

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.task_summary).toBe("Investigate auth flow"));
    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/sessions/conv_parent/child_sessions?limit=200",
      {
        signal: expect.any(AbortSignal),
      },
    );
  });
});
