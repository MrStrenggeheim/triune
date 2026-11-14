// Modified for Triune; inherited notices remain applicable.
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { BlockRenderer } from "@/components/blocks/BlockRenderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BubbleView } from "@/components/chat/chatBubbleParts";
import type * as ConversationModule from "@/components/ai-elements/conversation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/lib/notifications";
import { ApiError } from "@/lib/sessionsApi";
import type { Bubble } from "@/lib/renderItems";
import { useChatStore } from "@/store/chatStore";
import {
  CHAT_SEARCH_ACTIVE_HIGHLIGHT,
  CHAT_SEARCH_HIGHLIGHT,
  ChatSearchRevealContext,
} from "@/lib/chatSearchHighlights";
import {
  useChatSearchHighlights,
  type ChatSearchHighlightOptions,
  type ChatSearchResolution,
} from "./useChatSearchHighlights";

vi.mock("@/lib/notifications", () => ({ toast: { error: vi.fn() } }));

const releaseScrollLock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ai-elements/conversation", async (importOriginal) => ({
  ...(await importOriginal<typeof ConversationModule>()),
  releaseConversationScrollLock: releaseScrollLock,
}));

function user(itemId: string, text: string): Bubble {
  return { kind: "user", itemId, content: [{ type: "input_text", text }] };
}

const highlights = new Map<string, { ranges: Range[] }>();
let options: ChatSearchHighlightOptions;
let root: HTMLDivElement;
let scrollBy: ReturnType<typeof vi.fn<(options?: ScrollToOptions) => void>>;
let onResolved: ReturnType<typeof vi.fn<(result: ChatSearchResolution) => void>>;
function markup(itemId = "old", text = "😀 echo echo") {
  return `<div data-message-id="${itemId}"><p class="message-markdown">${text}</p></div>`;
}

beforeEach(() => {
  root = document.createElement("div");
  root.innerHTML = markup();
  document.body.append(root);
  scrollBy = vi.fn();
  Object.defineProperty(root, "scrollBy", { configurable: true, value: scrollBy });
  onResolved = vi.fn();
  releaseScrollLock.mockClear();
  highlights.clear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal(
    "Highlight",
    class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    },
  );
  Object.defineProperty(CSS, "highlights", { configurable: true, value: highlights });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, height: 20 }) as DOMRect,
  });
  root.getBoundingClientRect = () => ({ top: 0, height: 200 }) as DOMRect;
  useChatStore.setState({
    loadingConversation: false,
    loadingMoreHistory: false,
    hasMoreHistory: false,
    oldestItemId: "old",
    historyGeneration: 0,
  });
  options = {
    conversationId: "chat",
    query: "echo",
    container: root,
    scrollElement: root,
    bubbles: [user("old", "😀 echo echo")],
    ready: true,
    ensureMessageVisible: vi.fn(() => false),
    onResolved,
    target: {
      conversationId: "chat",
      itemId: "old",
      range: { start: 8, end: 12 },
      sourceText: "😀 echo echo",
      content_hash: "original",
      requestId: 1,
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("chat search navigation", () => {
  it("bounds advancing history pages and hanging history requests", async () => {
    vi.useFakeTimers();
    const loadMoreHistory = vi.fn(async () => {
      useChatStore.setState({ oldestItemId: `page-${loadMoreHistory.mock.calls.length}` });
    });
    useChatStore.setState({ hasMoreHistory: true, loadMoreHistory });
    const { unmount } = renderHook(() => useChatSearchHighlights({ ...options, bubbles: [] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_400);
    });
    expect(loadMoreHistory).toHaveBeenCalledTimes(40);
    expect(toast.error).toHaveBeenCalledOnce();
    unmount();
    vi.mocked(toast.error).mockClear();
    const hangingPage = vi.fn(() => new Promise<void>(() => {}));
    useChatStore.setState({ hasMoreHistory: true, loadMoreHistory: hangingPage });
    renderHook(() => useChatSearchHighlights({ ...options, bubbles: [] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(hangingPage).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledOnce();
    expect(onResolved).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("bounds mount and render polling without classifying valid content unavailable", async () => {
    vi.useFakeTimers();
    root.innerHTML = "";
    const { rerender } = renderHook((value) => useChatSearchHighlights(value), {
      initialProps: options,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    expect(options.ensureMessageVisible).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(onResolved).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    root.innerHTML = markup();
    rerender({ ...options, rangeNonce: 44 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(scrollBy).not.toHaveBeenCalled();
    rerender({ ...options, target: { ...options.target!, requestId: 2 } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(onResolved).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("waits for measured layout and corrects a late resize before resolving", async () => {
    let top = 100;
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top, height: 20 }),
    });
    renderHook(() => useChatSearchHighlights(options));
    expect(scrollBy).not.toHaveBeenCalled();
    await waitFor(() => expect(scrollBy).toHaveBeenCalledOnce());
    top += 5;
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    expect(scrollBy).toHaveBeenCalledTimes(2);
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 15, behavior: "auto" });
  });

  it.each(["wheel", "touchstart", "pointerdown", "keydown"])(
    "cancels pending alignment on manual %s and keeps repainting",
    async (type) => {
      const { rerender } = renderHook((value) => useChatSearchHighlights(value), {
        initialProps: options,
      });
      fireEvent(
        root,
        type === "keydown"
          ? new KeyboardEvent(type, { key: "PageDown", bubbles: true })
          : new Event(type),
      );
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
      });
      rerender({ ...options, rangeNonce: 55 });
      expect(scrollBy).not.toHaveBeenCalled();
      expect(onResolved).not.toHaveBeenCalled();
      expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0]?.toString()).toBe("echo");
      rerender({ ...options, target: { ...options.target!, requestId: 2 } });
      await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    },
  );

  it("keeps a delayed virtual row pending beyond the former 500ms timeout", async () => {
    root.innerHTML = "";
    renderHook(() => useChatSearchHighlights(options));
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 650);
      });
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    root.innerHTML = markup();
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    expect(options.ensureMessageVisible).toHaveBeenCalledTimes(3);
  });

  it("does not center an already mounted row while its content is render-pending", async () => {
    root.innerHTML = '<div data-message-id="old"></div>';
    renderHook(() => useChatSearchHighlights(options));
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 550);
      });
    });
    expect(options.ensureMessageVisible).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    root.innerHTML = markup();
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
  });

  it("reveals folded source-only Markdown and retains its owner state across remount", async () => {
    const text = "[echo](echo)";
    const bubble: Extract<Bubble, { kind: "assistant" }> = {
      kind: "assistant",
      responseId: "row",
      stableId: "row",
      lifecycle: "completed",
      error: null,
      items: [
        { kind: "text", itemId: "hidden", text, final: true },
        { kind: "text", itemId: "answer", text: "Visible answer.", final: true },
      ],
    };
    const target = {
      ...options.target!,
      itemId: "hidden",
      sourceText: text,
      range: { start: 7, end: 11 },
    };
    function Fixture({ mounted = true, requestId = 1 }: { mounted?: boolean; requestId?: number }) {
      const [revealedItems, setItems] = useState(new Set<string>());
      const [originalSources, setSources] = useState(new Map<string, string>());
      const [revealRequest, setRequest] = useState({ itemId: "", revision: 0 });
      const reveal = useMemo(
        () => ({
          revealedItems,
          originalSources,
          revealRequest,
          reveal: (id: string) => {
            setItems((ids) => new Set([...ids, id]));
            setRequest((previous) => ({ itemId: id, revision: previous.revision + 1 }));
          },
          showOriginal: (id: string, value: string) =>
            setSources((sources) => new Map([...sources, [id, value]])),
        }),
        [revealedItems, originalSources, revealRequest],
      );
      useChatSearchHighlights({
        ...options,
        bubbles: [bubble],
        target: { ...target, requestId },
        reveal,
      });
      return (
        <ChatSearchRevealContext.Provider value={reveal}>
          {mounted && (
            <div data-message-id="row">
              <BlockRenderer items={bubble.items} sessionStatus="idle" foldNarration />
            </div>
          )}
        </ChatSearchRevealContext.Provider>
      );
    }
    const snap = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: snap });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(<Fixture />, {
      container: root,
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    expect(root.querySelector('[data-testid="turn-worked-fold"]')).toHaveAttribute(
      "data-state",
      "open",
    );
    expect(root.querySelector("pre")?.textContent).toBe(text);
    expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0]?.startOffset).toBe(7);
    expect(snap).not.toHaveBeenCalled();
    rerender(<Fixture mounted={false} />);
    rerender(<Fixture />);
    expect(root.querySelector('[data-testid="turn-worked-fold"]')).toHaveAttribute(
      "data-state",
      "open",
    );
    expect(root.querySelector("pre")?.textContent).toBe(text);
    expect(scrollBy).toHaveBeenCalledOnce();
    fireEvent.click(root.querySelector('[data-testid="turn-worked-fold"] button')!);
    expect(root.querySelector('[data-testid="turn-worked-fold"]')).toHaveAttribute(
      "data-state",
      "closed",
    );
    rerender(<Fixture requestId={2} />);
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(2));
    expect(root.querySelector('[data-testid="turn-worked-fold"]')).toHaveAttribute(
      "data-state",
      "open",
    );
    expect(snap).not.toHaveBeenCalled();
  });

  it("keeps an active exact match when another conversation mounts, updates and unmounts", async () => {
    renderHook(() => useChatSearchHighlights(options));
    const active = highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0];
    expect(active?.toString()).toBe("echo");
    const other = document.createElement("div");
    other.innerHTML = markup();
    document.body.append(other);
    const inactive = {
      ...options,
      conversationId: "other",
      query: "",
      target: null,
      container: other,
    };
    const { rerender, unmount } = renderHook((value) => useChatSearchHighlights(value), {
      initialProps: inactive,
    });
    rerender({ ...inactive, bubbles: [user("old", "echo changed")] });
    expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0]).toBe(active);
    unmount();
    expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0]).toBe(active);
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
  });

  it("scrolls the exact repeated occurrence once and preserves focus/manual scroll through refreshes", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const { rerender } = renderHook((value) => useChatSearchHighlights(value), {
      initialProps: options,
    });
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({ target: options.target, status: "resolved" }),
    );
    expect(scrollBy).toHaveBeenCalledWith({ top: 10, behavior: "auto" });
    expect(document.activeElement).toBe(input);
    expect(highlights.get(CHAT_SEARCH_HIGHLIGHT)?.ranges).toHaveLength(2);
    expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0].startOffset).toBe(8);
    root.scrollTop = 777;
    rerender({
      ...options,
      bubbles: [...options.bubbles, user("new", "streaming echo")],
      target: { ...options.target! },
    });
    rerender({ ...options, rangeNonce: 99 });
    rerender({ ...options, target: { ...options.target!, content_hash: "refreshed" } });
    expect(root.scrollTop).toBe(777);
    expect(scrollBy).toHaveBeenCalledOnce();
    expect(releaseScrollLock).toHaveBeenCalledOnce();
    expect(onResolved).toHaveBeenCalledOnce();
    rerender({ ...options, target: { ...options.target!, requestId: 2 } });
    await waitFor(() => expect(scrollBy).toHaveBeenCalledTimes(2));
  });

  it("pages existing older-history cursors, then mounts the exact stored item", async () => {
    root.innerHTML = markup("new", "newest");
    let loaded: Bubble[] = [user("new", "newest")];
    const loadMoreHistory = vi.fn(async () => {
      if (loadMoreHistory.mock.calls.length === 1) {
        useChatStore.setState({ oldestItemId: "middle" });
      } else {
        loaded = [user("old", "😀 echo echo"), ...loaded];
        useChatStore.setState({ oldestItemId: "old", hasMoreHistory: false });
      }
    });
    const ensure = vi.fn((id) => {
      expect(id).toBe("old");
      root.innerHTML = markup();
      return true;
    });
    useChatStore.setState({ oldestItemId: "new", hasMoreHistory: true, loadMoreHistory });
    const { rerender } = renderHook(() =>
      useChatSearchHighlights({ ...options, bubbles: loaded, ensureMessageVisible: ensure }),
    );
    await waitFor(() => expect(loadMoreHistory).toHaveBeenCalledTimes(2));
    rerender();
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({ target: options.target, status: "resolved" }),
    );
    expect(ensure).toHaveBeenCalledOnce();
    expect(scrollBy).toHaveBeenCalledOnce();
  });

  it("offers Retry for a nonadvancing history cursor without an unavailable verdict", async () => {
    const loadMoreHistory = vi.fn(async () => {});
    useChatStore.setState({ hasMoreHistory: true, loadMoreHistory });
    renderHook(() => useChatSearchHighlights({ ...options, bubbles: [] }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn’t load this message.",
        expect.objectContaining({ action: expect.objectContaining({ label: "Retry" }) }),
      ),
    );
    expect(onResolved).not.toHaveBeenCalled();
    expect(loadMoreHistory).toHaveBeenCalledOnce();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it.each([
    [403, "access"],
    [404, "no longer available"],
    [503, "Couldn’t load"],
  ])("reports typed history failure %s through shared notifications", async (status, message) => {
    useChatStore.setState({
      hasMoreHistory: true,
      loadMoreHistory: vi.fn(async () => {
        throw new ApiError("history failed", Number(status), null);
      }),
    });
    renderHook(() => useChatSearchHighlights({ ...options, bubbles: [] }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining(String(message)),
        expect.anything(),
      ),
    );
    expect(onResolved).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("retries a page failure after the store disabled history without losing the selected occurrence", async () => {
    const loadMoreHistory = vi.fn(async () => {
      if (loadMoreHistory.mock.calls.length === 1) {
        useChatStore.setState({ hasMoreHistory: false });
        throw new Error("network");
      }
      useChatStore.setState({ oldestItemId: "loaded", hasMoreHistory: false });
    });
    useChatStore.setState({ hasMoreHistory: true, loadMoreHistory });
    const { rerender } = renderHook((value) => useChatSearchHighlights(value), {
      initialProps: { ...options, bubbles: [] as Bubble[] },
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    const action = vi.mocked(toast.error).mock.calls[0][1]!.action;
    if (!action || typeof action !== "object" || !("onClick" in action))
      throw new Error("Missing Retry action");
    act(() => {
      action.onClick({} as never);
    });
    await waitFor(() => expect(loadMoreHistory).toHaveBeenCalledTimes(2));
    rerender({ ...options, bubbles: [...options.bubbles] });
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0]?.startOffset).toBe(8);
    act(() => {
      action.onClick({} as never);
    });
    expect(useChatStore.getState().hasMoreHistory).toBe(false);
  });

  it("rejects changed content even when the same snippet still exists", () => {
    renderHook(() =>
      useChatSearchHighlights({ ...options, bubbles: [user("old", "changed 😀 echo echo")] }),
    );
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("changed"), expect.anything());
    expect(onResolved).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges).toHaveLength(0);
  });

  it("clears the active highlight when its loaded source changes after resolution", async () => {
    const { rerender } = renderHook((value) => useChatSearchHighlights(value), {
      initialProps: options,
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    rerender({ ...options, bubbles: [user("old", "changed 😀 echo echo")] });
    expect(onResolved).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
    expect(scrollBy).toHaveBeenCalledOnce();
    expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges).toHaveLength(0);
  });

  it("maps a bounded source window back to full UTF16 offsets after many emoji", async () => {
    const text = "😀 ".repeat(12000) + "echo 😀 echo";
    const textStart = 30000;
    const start = text.lastIndexOf("echo");
    root.innerHTML = markup("old", text);
    renderHook(() =>
      useChatSearchHighlights({
        ...options,
        bubbles: [user("old", text)],
        target: {
          ...options.target!,
          sourceText: text.slice(textStart),
          textStart,
          range: { start: start - textStart, end: start - textStart + 4 },
        },
      }),
    );
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ status: "resolved" })),
    );
    expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0].startOffset).toBe(start);
    expect(scrollBy).toHaveBeenCalledOnce();
  });

  it("rejects a stale bounded source window without using a surviving snippet", () => {
    renderHook(() =>
      useChatSearchHighlights({
        ...options,
        target: {
          ...options.target!,
          sourceText: "echo echo",
          textStart: 2,
          range: { start: 5, end: 9 },
        },
      }),
    );
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("changed"), expect.anything());
    expect(onResolved).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it.each([
    {
      text: "echo " + "padding ".repeat(200) + "echo " + "later ".repeat(2200),
      query: "echo",
      textStart: 0,
    },
    { text: "😀 echo " + "padding ".repeat(1800) + "echo", query: "echo", textStart: 0 },
    {
      text: "😀".repeat(35000) + " Oldest reference needle✓ then needle✓.",
      query: "needle✓",
      textStart: 69916,
    },
  ])(
    "opens the actual collapsed prompt at source offset $textStart before selecting its older occurrence",
    async ({ text, query, textStart }) => {
      const bubble = user("old", text);
      const start = text.lastIndexOf(query);
      render(
        <QueryClientProvider client={new QueryClient()}>
          <BubbleView bubble={bubble} />
        </QueryClientProvider>,
        { container: root },
      );
      expect(root.textContent).toContain("Show full prompt (");
      renderHook(() =>
        useChatSearchHighlights({
          ...options,
          query,
          bubbles: [bubble],
          target: {
            ...options.target!,
            sourceText: text.slice(textStart),
            textStart,
            range: { start: start - textStart, end: start - textStart + query.length },
          },
        }),
      );
      await waitFor(() =>
        expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ status: "resolved" })),
      );
      expect(root.textContent).toContain("Collapse prompt");
      expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0].toString()).toBe(query);
      expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges[0].startOffset).toBe(start);
      expect(highlights.get(CHAT_SEARCH_HIGHLIGHT)?.ranges).toHaveLength(2);
      expect(scrollBy).toHaveBeenCalledOnce();
      expect(root.querySelector("mark")).toBeNull();
    },
  );

  it("clears painting without navigation when presentation bubbles disappear", async () => {
    const { rerender } = renderHook((value) => useChatSearchHighlights(value), {
      initialProps: options,
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    rerender({ ...options, bubbles: [] });
    expect(onResolved).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
    expect(scrollBy).toHaveBeenCalledOnce();
  });

  it("ignores another conversation and superseded history completions", async () => {
    let finish!: () => void;
    const loadMoreHistory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    useChatStore.setState({ hasMoreHistory: true, loadMoreHistory });
    const { rerender } = renderHook((value) => useChatSearchHighlights(value), {
      initialProps: { ...options, bubbles: [] },
    });
    rerender({ ...options, conversationId: "other", bubbles: [] });
    await act(async () => {
      finish();
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("cleans up painting when search closes without moving the viewport", async () => {
    const { rerender, unmount } = renderHook((value) => useChatSearchHighlights(value), {
      initialProps: options,
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    rerender({ ...options, target: null, query: "" });
    expect(highlights.get(CHAT_SEARCH_ACTIVE_HIGHLIGHT)?.ranges).toHaveLength(0);
    expect(scrollBy).toHaveBeenCalledOnce();
    unmount();
    expect(highlights.size).toBe(0);
  });
});
