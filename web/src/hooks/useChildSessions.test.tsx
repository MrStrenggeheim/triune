// Modified for Triune.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authenticatedFetch } from "@/lib/identity";
import {
  fetchChildSessions,
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
  it("preserves recorded identity and activity times across all child pages", async () => {
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
          data: [{ id: "older", task_summary: "Still running", busy: true }],
          has_more: false,
        }),
      );
    const children = await fetchChildSessions("root");
    expect(children.map((child) => child.id)).toEqual(["newer", "older"]);
    expect(children[0]).toMatchObject({ agent_name: "James", created_at: 100, updated_at: 300 });
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      "/v1/sessions/root/child_sessions?after=newer",
    );
  });

  it("rejects a repeated pagination cursor without returning a partial list", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async () =>
      Response.json({ data: [], has_more: true, last_id: "same" }),
    );
    await expect(fetchChildSessions("root")).rejects.toThrow("invalid cursor");
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
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
    expect(authenticatedFetch).toHaveBeenCalledWith("/v1/sessions/conv_parent/child_sessions");
  });
});
