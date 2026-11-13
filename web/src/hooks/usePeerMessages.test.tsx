// Modified for Triune.
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import { useViewerId } from "@/hooks/useViewerId";
import { getOmnigentServerIdentity } from "@/lib/host";
import { conversationRegistry } from "@/store/conversationRegistry";
import type { UserMessageBlock } from "@/lib/blocks";
import { fetchIncomingPeerMessages, fetchPeerMessages, usePeerMessages } from "./usePeerMessages";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/hooks/useViewerId", () => ({ useViewerId: vi.fn(() => "account") }));
vi.mock("@/lib/host", () => ({ getOmnigentServerIdentity: vi.fn(() => "server") }));
const fetch = vi.mocked(authenticatedFetch);
const outbox = vi.fn<typeof authenticatedFetch>();
const history = vi.fn<typeof authenticatedFetch>();
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const message = (id: string, source = "chat", destination = "other") => ({
  id,
  type: "message",
  content: [{ type: "input_text", text: `Text ${id}` }],
  communication: {
    kind: "peer",
    message_id: id,
    source_conversation_id: source,
    destination_conversation_id: destination,
    delivery_state: "confirmed",
    sent_at: 100,
  },
});
const page = (data: unknown[] = [], last_id: string | null = null, has_more = false) =>
  Response.json({ data, last_id, has_more });
function incoming(id: string, destination = "chat"): UserMessageBlock {
  return {
    type: "user_message",
    ctx: { agent: null, depth: 0, turn: 0, timestamp: 0, responseId: "response", itemId: id },
    content: [{ type: "input_text", text: `Incoming ${id}` }],
    communication: {
      kind: "peer",
      message_id: id,
      source_conversation_id: "sender",
      destination_conversation_id: destination,
      delivery_state: "confirmed",
      sent_at: 101,
    },
  };
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  outbox.mockReset().mockImplementation(async () => page());
  history.mockReset().mockImplementation(async () => page());
  fetch
    .mockReset()
    .mockImplementation((path, options) =>
      String(path).includes("/peer-messages?") ? outbox(path, options) : history(path, options),
    );
  vi.mocked(useViewerId).mockReturnValue("account");
  vi.mocked(getOmnigentServerIdentity).mockReturnValue("server");
});
afterEach(() => {
  cleanup();
  client.clear();
  conversationRegistry.clear();
  vi.useRealTimers();
});

it("pauses both hidden history polls without discarding pages or live messages", async () => {
  vi.useFakeTimers();
  outbox.mockImplementation(async () => page([message("outgoing")]));
  const { result, rerender } = renderHook(
    ({ active }) => usePeerMessages("chat", { enabled: active }),
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
  const outgoing = result.current.data;
  const incomingPages = result.current.incomingHistory.data;
  expect(result.current.messages.map((item) => item.id)).toEqual(["outgoing"]);
  rerender({ active: false });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["peer-messages"] });
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(outbox).toHaveBeenCalledTimes(1);
  expect(history).toHaveBeenCalledTimes(1);
  expect(result.current.data).toBe(outgoing);
  expect(result.current.incomingHistory.data).toBe(incomingPages);
  rerender({ active: true });
  expect(result.current.messages.map((item) => item.id)).toEqual(["outgoing"]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(outbox).toHaveBeenCalledTimes(2);
  expect(history).toHaveBeenCalledTimes(2);
});

it.each([null, "", "temp:pending"])("does not fetch for %s", (id) => {
  renderHook(() => usePeerMessages(id), { wrapper });
  expect(fetch).not.toHaveBeenCalled();
});

it("pages past empty transcript pages, deduplicates overlapping pages and does not invent confirmations", async () => {
  outbox
    .mockResolvedValueOnce(page([], "cursor/one", true))
    .mockResolvedValueOnce(page([message("message")], "cursor-two", true))
    .mockResolvedValueOnce(
      page(
        [
          {
            ...message("message"),
            communication: { ...message("message").communication, delivery_state: "unknown" },
          },
          message("older"),
        ],
        "last",
      ),
    );
  const { result } = renderHook(() => usePeerMessages("chat"), { wrapper });
  await waitFor(() => expect(result.current.hasNextPage).toBe(true));
  expect(result.current.messages).toEqual([]);
  expect(outbox).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.fetchNextPage();
  });
  expect(outbox.mock.calls[1][0]).toBe(
    "/v1/sessions/chat/peer-messages?limit=100&after=cursor%2Fone",
  );
  await act(async () => {
    await result.current.fetchNextPage();
  });
  expect(result.current.messages.map((item) => item.id)).toEqual(["message", "older"]);
  expect(result.current.messages[0].communication.delivery_state).toBe("confirmed");
  expect(result.current.hasNextPage).toBe(false);
});

it("reads only the named incoming registry and drops its messages on disposal", async () => {
  conversationRegistry
    .acquire("chat")
    .setState({ blocks: [incoming("incoming"), incoming("wrong", "other")] });
  conversationRegistry.acquire("other").setState({ blocks: [incoming("not-this-chat", "other")] });
  outbox.mockImplementation(async () =>
    page([message("outgoing"), message("wrong-source", "other")]),
  );
  const { result } = renderHook(() => usePeerMessages("chat"), { wrapper });
  await waitFor(() => expect(result.current.messages).toHaveLength(2));
  expect(result.current.messages.map((item) => [item.id, item.direction])).toEqual([
    ["incoming", "incoming"],
    ["outgoing", "outgoing"],
  ]);
  act(() => conversationRegistry.release("chat"));
  expect(result.current.messages.map((item) => item.id)).toEqual(["outgoing"]);
});

it("scopes queries to account and server and cancels superseded chat requests", async () => {
  let finish!: (response: Response) => void;
  outbox
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementation(async () => page());
  const { result, rerender } = renderHook(({ id }) => usePeerMessages(id), {
    initialProps: { id: "chat" },
    wrapper,
  });
  await waitFor(() => expect(outbox).toHaveBeenCalledTimes(1));
  const signal = outbox.mock.calls[0][1]?.signal;
  rerender({ id: "next" });
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(page([message("stale")])));
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.messages).toEqual([]);
  vi.mocked(useViewerId).mockReturnValue("other-account");
  rerender({ id: "next" });
  await waitFor(() => expect(outbox).toHaveBeenCalledTimes(3));
  vi.mocked(getOmnigentServerIdentity).mockReturnValue("other-server");
  rerender({ id: "next" });
  await waitFor(() => expect(outbox).toHaveBeenCalledTimes(4));
});

it("does not request data while authority is unresolved", async () => {
  vi.mocked(useViewerId).mockReturnValue(null);
  const { result } = renderHook(() => usePeerMessages("chat"), { wrapper });
  await act(async () => {
    await result.current.refetch();
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current.messages).toEqual([]);
});

it("reports invalid pagination and HTTP errors without retrying or guessing receipts", async () => {
  outbox.mockResolvedValueOnce(page([], "same", true));
  await expect(fetchPeerMessages("chat", "same")).rejects.toThrow("pagination");
  outbox.mockResolvedValueOnce(Response.json({ detail: "Not allowed" }, { status: 403 }));
  const { result } = renderHook(() => usePeerMessages("chat"), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.messages).toEqual([]);
  expect(outbox).toHaveBeenCalledTimes(2);
});

it("hides cached message text when access is revoked but keeps it through ordinary offline errors", async () => {
  conversationRegistry.acquire("chat").setState({ blocks: [incoming("incoming")] });
  outbox.mockResolvedValueOnce(page([message("outgoing")]));
  const { result } = renderHook(() => usePeerMessages("chat"), { wrapper });
  await waitFor(() => expect(result.current.messages).toHaveLength(2));
  outbox.mockResolvedValueOnce(Response.json({ detail: "Offline" }, { status: 503 }));
  await act(async () => {
    await result.current.refetch();
  });
  expect(result.current.messages).toHaveLength(2);
  outbox.mockResolvedValueOnce(Response.json({ detail: "Forbidden" }, { status: 403 }));
  await act(async () => {
    await result.current.refetch();
  });
  expect(result.current.messages).toEqual([]);
});

const historyMessage = (id: string, deliveryState = "confirmed", sentAt = 100) => ({
  ...message(id, "sender", "chat"),
  role: "user",
  response_id: "response",
  status: "completed",
  communication: {
    ...message(id, "sender", "chat").communication,
    delivery_state: deliveryState,
    sent_at: sentAt,
  },
});

it("loads incoming peer and native agent messages in a cold standalone Activity without binding", async () => {
  history.mockResolvedValueOnce(
    page([
      {
        ...historyMessage("native", "unknown", 103),
        communication: {
          ...historyMessage("native", "unknown", 103).communication,
          kind: "native_agent",
          source_conversation_id: null,
        },
      },
      historyMessage("pending", "pending", 102),
      historyMessage("queued", "queued", 101),
      historyMessage("confirmed", "confirmed", 100),
      { ...historyMessage("normal"), communication: undefined },
      { ...historyMessage("assistant"), role: "assistant" },
      message("wrong-destination"),
      { ...historyMessage("invalid"), communication: { kind: "peer" } },
    ]),
  );
  const acquire = vi.spyOn(conversationRegistry, "acquire");
  const { result } = renderHook(() => usePeerMessages("chat"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(
    result.current.messages.map((item) => [
      item.id,
      item.direction,
      item.communication.delivery_state,
    ]),
  ).toEqual([
    ["native", "incoming", "unknown"],
    ["pending", "incoming", "pending"],
    ["queued", "incoming", "queued"],
    ["confirmed", "incoming", "confirmed"],
  ]);
  expect(history.mock.calls[0][0]).toBe("/v1/sessions/chat/items?limit=100&order=desc");
  expect(conversationRegistry.peek("chat")).toBeUndefined();
  expect(acquire).not.toHaveBeenCalled();
  acquire.mockRestore();
  expect(
    fetch.mock.calls.every(
      ([path, options]) =>
        String(path).startsWith("/v1/sessions/chat/") &&
        (!options?.method || options.method === "GET"),
    ),
  ).toBe(true);
});

it("pages incoming history through non-peer items and deduplicates overlaps and live messages", async () => {
  history
    .mockResolvedValueOnce(page([{ id: "cursor/one", type: "function_call" }], "cursor/one", true))
    .mockResolvedValueOnce(
      page(
        [historyMessage("duplicate", "confirmed", 102), { id: "cursor-two", type: "error" }],
        "cursor-two",
        true,
      ),
    )
    .mockResolvedValueOnce(
      page(
        [historyMessage("duplicate", "unknown", 102), historyMessage("old", "failed", 90)],
        "old",
      ),
    );
  const { result } = renderHook(() => usePeerMessages("chat"), { wrapper });
  await waitFor(() => expect(result.current.incomingHistory.hasNextPage).toBe(true));
  expect(result.current.messages).toEqual([]);
  expect(history).toHaveBeenCalledTimes(1);
  // Transcript paging must not consume an outgoing cursor.
  expect(result.current.hasNextPage).toBe(false);
  await act(async () => {
    await result.current.incomingHistory.fetchNextPage();
  });
  expect(history.mock.calls[1][0]).toBe(
    "/v1/sessions/chat/items?limit=100&order=desc&after=cursor%2Fone",
  );
  await act(async () => {
    await result.current.incomingHistory.fetchNextPage();
  });
  expect(result.current.messages.map((item) => item.id)).toEqual(["duplicate", "old"]);
  expect(result.current.messages[0].communication.delivery_state).toBe("confirmed");
  act(() =>
    conversationRegistry
      .acquire("chat")
      .setState({ blocks: [incoming("duplicate"), incoming("live")] }),
  );
  expect(result.current.messages).toHaveLength(3);
  expect(result.current.messages.find((item) => item.id === "duplicate")?.content).toEqual(
    incoming("duplicate").content,
  );
  expect(result.current.incomingHistory.hasNextPage).toBe(false);
  expect(outbox).toHaveBeenCalledTimes(1);
  act(() => conversationRegistry.release("chat"));
  expect(result.current.messages.map((item) => item.id)).toEqual(["duplicate", "old"]);
});

it.each([401, 403, 404])(
  "hides all cached and live text when incoming history denies access with %s",
  async (status) => {
    history.mockResolvedValueOnce(page([historyMessage("saved")]));
    outbox.mockImplementation(async () => page([message("outgoing")]));
    conversationRegistry.acquire("chat").setState({ blocks: [incoming("live")] });
    const { result } = renderHook(() => usePeerMessages("chat"), { wrapper });
    await waitFor(() => expect(result.current.messages).toHaveLength(3));
    history.mockResolvedValueOnce(Response.json({ detail: "Offline" }, { status: 503 }));
    await act(async () => {
      await result.current.incomingHistory.refetch();
    });
    expect(result.current.messages).toHaveLength(3);
    history.mockResolvedValueOnce(Response.json({ detail: "Access denied" }, { status }));
    await act(async () => {
      await result.current.incomingHistory.refetch();
    });
    expect(result.current.isError).toBe(true);
    expect(result.current.messages).toEqual([]);
    expect(result.current.error?.message).toBe("Access denied");
  },
);

it("cancels incoming reads and rejects stale history/registry data across account and server switches", async () => {
  let finish!: (response: Response) => void;
  history
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementation(async () => page([historyMessage("current")]));
  conversationRegistry.acquire("chat").setState({ blocks: [incoming("old-registry")] });
  const { result, rerender } = renderHook(() => usePeerMessages("chat"), { wrapper });
  await waitFor(() => expect(history).toHaveBeenCalledOnce());
  const signal = history.mock.calls[0][1]?.signal;
  vi.mocked(useViewerId).mockReturnValue("other-account");
  rerender();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(page([historyMessage("stale")])));
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.messages.map((item) => item.id)).toEqual(["current"]);
  expect(
    client.getQueryData(["peer-messages", "incoming", "other-account", "server", "chat"]),
  ).toBeDefined();
  history.mockImplementation(async () => page([historyMessage("other-server")]));
  vi.mocked(getOmnigentServerIdentity).mockReturnValue("other-server");
  rerender();
  await waitFor(() =>
    expect(result.current.messages.map((item) => item.id)).toEqual(["other-server"]),
  );
  expect(history).toHaveBeenCalledTimes(3);
});

it("rejects incoming cursor stalls rather than scanning unbounded history", async () => {
  history.mockResolvedValueOnce(page([historyMessage("same")], "same", true));
  await expect(fetchIncomingPeerMessages("chat", "same")).rejects.toThrow("pagination");
  history.mockResolvedValueOnce(page([], "missing", true));
  await expect(fetchIncomingPeerMessages("chat", null)).rejects.toThrow("pagination");
  expect(history).toHaveBeenCalledTimes(2);
});
