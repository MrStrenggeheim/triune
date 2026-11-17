// Modified for Triune.
import {
  readTranscriptReaderCheckpoint,
  rememberTranscriptReaderCheckpoint,
  setTranscriptReaderHydrator,
  type TranscriptReaderRestoreRequest,
} from "@/lib/transcriptReaderCheckpoint";
import { ResourceViewIdContext } from "@/lib/panelFolder";
import { createRef } from "react";
import type * as ReactVirtualModule from "@tanstack/react-virtual";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { claimTranscriptScrollOwner } from "@/hooks/useTranscriptDisclosureAnchor";
import { measureElement, useVirtualizer } from "@tanstack/react-virtual";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { AnyBlock } from "@/lib/blocks";
import type { ConversationBranch } from "@/lib/conversationBranches";
import type { Bubble } from "@/lib/renderItems";
import { useChatStore } from "@/store/chatStore";
import * as chatStore from "@/store/chatStore";
import { conversationRegistry } from "@/store/conversationRegistry";
import * as scopedChat from "@/workbench/ScopedChatStore";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import {
  isNativeFindShortcut,
  Transcript,
  type TranscriptGeometry,
  VirtualBubbleList,
} from "./Transcript";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const bubble: Extract<Bubble, { kind: "user" }> = {
  kind: "user",
  itemId: "user-1",
  userAuthored: true,
  content: [{ type: "input_text", text: "hello" }],
};

const assistantBubble: Extract<Bubble, { kind: "assistant" }> = {
  kind: "assistant",
  responseId: "response-1",
  stableId: "response-1",
  lifecycle: "completed",
  error: null,
  items: [{ kind: "text", itemId: "assistant-1", text: "hello back", final: true }],
};

it("folds only opted-in subchat history and preserves child messages across disclosure", () => {
  const branch: ConversationBranch = {
    source_conversation_id: "parent",
    inherited_item_count: 1,
    inherited_last_item_id: "inherited",
    reference_only: true,
    recovery: "replay",
  };
  const blocks: AnyBlock[] = ["inherited", "child"].map((id) => ({
    type: "user_message",
    ctx: { itemId: id, responseId: id, agent: null, depth: 0, turn: 0, timestamp: 0 },
    content: [{ type: "input_text", text: `${id} message` }],
  }));
  const previous = useChatStore.getState();
  useChatStore.setState({
    conversationId: "history-child",
    blocks,
    pendingUserMessages: [],
    activeResponse: null,
    sessionStatus: "idle",
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (hideInheritedHistory: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Transcript
          branch={branch}
          hideInheritedHistory={hideInheritedHistory}
          hostId={null}
          setConversationEl={() => {}}
          containerEl={null}
          scroller={null}
          setScroller={() => {}}
          sendScrollNonce={0}
          hasMoreHistory={false}
          loadingMoreHistory={false}
          isMobileViewport
          showsWorking={false}
          agentsError={null}
          sandboxLaunching={false}
          spacerMeasureRef={{ current: null }}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  try {
    const result = render(view(true));
    expect(screen.queryByText("inherited message")).not.toBeInTheDocument();
    expect(screen.getByText("child message")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show history" }));
    expect(screen.getByText("inherited message")).toBeVisible();
    expect(screen.getByText("child message")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hide history" }));
    expect(screen.queryByText("inherited message")).not.toBeInTheDocument();
    expect(screen.getByText("child message")).toBeVisible();
    result.rerender(view(false));
    expect(screen.getByText("inherited message")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show history" })).not.toBeInTheDocument();
    result.unmount();
  } finally {
    useChatStore.setState(previous);
    client.clear();
  }
});

function list(
  hasTasks: boolean,
  scrollEl: HTMLElement,
  onGeometryChange: (geometry: TranscriptGeometry) => void = vi.fn(),
  disableVirtualization = false,
  bubbles: Bubble[] = [bubble],
  conversationId?: string,
) {
  return (
    <Conversation>
      <ConversationContent>
        <VirtualBubbleList
          bubbles={bubbles}
          scrollEl={scrollEl}
          lastAssistantIndex={-1}
          showsWorking={false}
          sessionIdle
          conversationId={conversationId}
          hasTasks={hasTasks}
          disableVirtualization={disableVirtualization}
          onGeometryChange={onGeometryChange}
        />
      </ConversationContent>
    </Conversation>
  );
}

function messageList(bubbles: Bubble[], showsWorking: boolean, sessionIdle: boolean) {
  return (
    <Conversation>
      <ConversationContent>
        <VirtualBubbleList
          bubbles={bubbles}
          scrollEl={null}
          lastAssistantIndex={bubbles.findLastIndex((item) => item.kind === "assistant")}
          showsWorking={showsWorking}
          sessionIdle={sessionIdle}
          conversationId="conv-1"
          hasTasks={false}
          disableVirtualization
          onGeometryChange={vi.fn()}
        />
      </ConversationContent>
    </Conversation>
  );
}

function actionFooter(button: HTMLElement): HTMLElement {
  return button.parentElement!.parentElement!;
}

it("remeasures scrollMargin when task padding changes without changing bubbles", async () => {
  const scrollEl = document.createElement("div");
  Object.defineProperties(scrollEl, {
    scrollTop: { configurable: true, writable: true, value: 0 },
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1_000 },
  });
  scrollEl.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

  const bubbles = ["user-0", "user-1", "user-2"].map((itemId) => ({ ...bubble, itemId }));
  // Mount only the middle row, at the library's offsets: 200px rows `gap` apart after `scrollMargin`.
  const passThrough = vi.mocked(useVirtualizer).getMockImplementation()!;
  vi.mocked(useVirtualizer).mockImplementation((options) => {
    const start = options.scrollMargin! + 200 + options.gap!;
    const row = {
      index: 1,
      key: options.getItemKey!(1),
      start,
      size: 200,
      end: start + 200,
      lane: 0,
    };
    const totalSize = 3 * 200 + 2 * options.gap!;
    return {
      ...passThrough(options),
      getVirtualItems: () => [row],
      getTotalSize: () => totalSize,
    } as never;
  });
  try {
    const view = render(list(false, scrollEl, vi.fn(), false, bubbles));
    const row = view.container.querySelector<HTMLElement>('[data-index="1"]')!;
    expect(row).toHaveAttribute("data-bubble-key", "user:user-1");
    const wrapper = row.parentElement!;
    expect(wrapper).toHaveStyle("padding-top: 216px; padding-bottom: 216px");
    wrapper.getBoundingClientRect = () => ({ top: 64 }) as DOMRect;

    view.rerender(list(true, scrollEl, vi.fn(), false, bubbles));

    await waitFor(() => expect(vi.mocked(useVirtualizer).mock.lastCall?.[0].scrollMargin).toBe(64));
    expect(wrapper).toHaveStyle("padding-top: 216px; padding-bottom: 216px");
  } finally {
    vi.mocked(useVirtualizer).mockImplementation(passThrough);
  }
});

it("measures rows at their unrounded border-box height", () => {
  const view = render(list(false, document.createElement("div")));
  const row = view.container.querySelector<HTMLElement>('[data-index="0"]')!;
  const measure = vi.mocked(useVirtualizer).mock.lastCall![0].measureElement!;
  const entry = { borderBoxSize: [{ blockSize: 58.796875, inlineSize: 600 }] };
  const instance = {
    options: { getItemKey: () => "user:user-1", estimateSize: () => 280, horizontal: false },
    indexFromElement: () => 0,
    itemSizeCache: new Map([["user:user-1", 340.625]]),
  };

  expect(measure(row, entry as unknown as ResizeObserverEntry, instance as never)).toBe(58.796875);
  expect(measure(row, undefined, instance as never)).toBe(
    measureElement(row, undefined, instance as never),
  );

  // A first mount has no cached size; read the unrounded box, not offsetHeight.
  instance.itemSizeCache.clear();
  row.getBoundingClientRect = () => ({ height: 58.796875 }) as DOMRect;
  expect(measure(row, undefined, instance as never)).toBe(58.796875);
  expect(
    measure(
      row,
      { borderBoxSize: [{ blockSize: 0 }] } as unknown as ResizeObserverEntry,
      instance as never,
    ),
  ).toBe(280);
});

it("restores a retained reader anchor after hidden clamping, without accepting hidden scrolls", async () => {
  vi.useFakeTimers();
  const visible = vi.spyOn(scopedChat, "useConversationChatVisible").mockReturnValue(true);
  const id = "hidden-reader-anchor";
  const entry = conversationRegistry.acquire(id);
  entry.setState({
    historyGeneration: 1,
    hasMoreHistory: false,
    blocks: Array.from({ length: 8 }, (_, index) => ({
      type: "user_message" as const,
      ctx: {
        itemId: `retained-${index}`,
        responseId: `retained-${index}`,
        agent: null,
        depth: 0,
        turn: 0,
        timestamp: 0,
      },
      content: [{ type: "input_text" as const, text: "hello" }],
    })),
  });
  useChatStore.setState({ conversationId: id });
  const scrollEl = document.createElement("div");
  Object.defineProperties(scrollEl, {
    scrollTop: { configurable: true, writable: true, value: 0 },
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 2000 },
  });
  const bubbles = Array.from({ length: 8 }, (_, index) => ({
    ...bubble,
    itemId: `retained-${index}`,
  }));
  const tree = () => list(false, scrollEl, vi.fn(), false, bubbles, id);
  const view = render(tree());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(64);
  });
  scrollEl.scrollTop = 333;
  fireEvent.scroll(scrollEl);
  visible.mockReturnValue(false);
  view.rerender(tree());
  expect(vi.mocked(useVirtualizer).mock.lastCall![0].useCachedMeasurements).toBe(true);
  scrollEl.scrollTop = 0;
  fireEvent.scroll(scrollEl);
  visible.mockReturnValue(true);
  view.rerender(tree());
  await act(async () => {
    await Promise.resolve();
  });
  expect(scrollEl.scrollTop).toBe(333);
  fireEvent.wheel(scrollEl);
  scrollEl.scrollTop = 420;
  fireEvent.scroll(scrollEl);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(64);
  });
  expect(scrollEl.scrollTop).toBe(420);
  conversationRegistry.release(id);
});

it.each([false, true])(
  "saved restore yields permanently to explicit navigation, saved anchor=%s",
  async (hasAnchor) => {
    vi.useFakeTimers();
    const visible = vi.spyOn(scopedChat, "useConversationChatVisible").mockReturnValue(true);
    const id = `restore-search-owner-${hasAnchor}`;
    useChatStore.setState({ conversationId: id });
    const scrollEl = document.createElement("div");
    Object.defineProperties(scrollEl, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 3000 },
    });
    const bubbles = Array.from({ length: 12 }, (_, index) => ({
      ...bubble,
      itemId: `${id}-${index}`,
    }));
    const tree = () => list(false, scrollEl, vi.fn(), false, bubbles, id);
    const view = render(tree());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(64);
    });
    scrollEl.scrollTop = hasAnchor ? 333 : 2500;
    fireEvent.scroll(scrollEl);
    visible.mockReturnValue(false);
    view.rerender(tree());
    visible.mockReturnValue(true);
    view.rerender(tree());
    // Search can be accepted after the retained pane has started restoring.
    const release = claimTranscriptScrollOwner(scrollEl);
    scrollEl.scrollTop = 900;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(64);
    });
    expect(scrollEl.scrollTop).toBe(900);
    release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });
    expect(scrollEl.scrollTop).toBe(900);
  },
);

it("publishes navigation that distinguishes loaded and missing turns", async () => {
  const scrollEl = document.createElement("div");
  const onGeometryChange = vi.fn<(geometry: TranscriptGeometry) => void>();
  const passThrough = vi.mocked(useVirtualizer).getMockImplementation()!;
  const cancelScroll = vi.fn();
  const scrollToIndex = vi.fn();
  vi.mocked(useVirtualizer).mockImplementation((options) =>
    Object.assign(passThrough(options), { cancelScroll, scrollToIndex }),
  );

  render(list(false, scrollEl, onGeometryChange));

  await waitFor(() => expect(onGeometryChange).toHaveBeenCalled());
  const geometry = onGeometryChange.mock.calls.at(-1)![0];
  expect(geometry.scrollToItem("user-1")).toBe(true);
  expect(geometry.scrollToItem("missing")).toBe(false);
  geometry.cancelPendingScroll();
  expect(cancelScroll).toHaveBeenCalledOnce();
  expect(geometry.scrollToItem("user-1", true)).toBe(true);
  expect(cancelScroll).toHaveBeenCalledTimes(2);
  expect(scrollToIndex).toHaveBeenCalledOnce();
});

it("recognizes unhandled native find keyboard shortcuts", () => {
  expect(
    isNativeFindShortcut({
      key: "f",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      defaultPrevented: false,
    }),
  ).toBe(true);
  expect(
    isNativeFindShortcut({
      key: "f",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      defaultPrevented: false,
    }),
  ).toBe(true);
  expect(
    isNativeFindShortcut({
      key: "f",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      defaultPrevented: true,
    }),
  ).toBe(false);
});

it("renders every bubble in normal flow after native find is detected", () => {
  const scrollEl = document.createElement("div");

  const view = render(list(false, scrollEl, vi.fn(), true));

  expect(view.container.querySelector('[data-index="0"]')).toBeNull();
  expect(view.container.querySelectorAll('[data-testid="message-bubble"]')).toHaveLength(1);
});

it("keeps the found position when search navigation closes", () => {
  useChatStore.setState({ conversationId: "search-close-location" });
  const scrollEl = document.createElement("div");
  Object.defineProperties(scrollEl, {
    scrollTop: { configurable: true, writable: true, value: 333 },
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 2000 },
  });
  const view = (messageId: string | null) => (
    <Conversation>
      <ConversationContent>
        <VirtualBubbleList
          bubbles={[bubble]}
          scrollEl={scrollEl}
          lastAssistantIndex={-1}
          showsWorking={false}
          sessionIdle
          conversationId="search-close-location"
          hasTasks={false}
          disableVirtualization={false}
          messageId={messageId}
          onGeometryChange={vi.fn()}
        />
      </ConversationContent>
    </Conversation>
  );
  const rendered = render(view("user-1"));
  scrollEl.scrollTop = 444;
  rendered.rerender(view(null));
  expect(scrollEl.scrollTop).toBe(444);
});

it("keeps actions visible only on a final assistant message while idle", () => {
  const bubbles: Bubble[] = [bubble, assistantBubble, { kind: "compaction", itemId: "compact-1" }];
  const view = render(messageList(bubbles, false, true));
  const copyButtons = screen.getAllByRole("button", { name: "Copy" });

  expect(actionFooter(copyButtons[0]!)).toHaveClass("md:opacity-0");
  expect(actionFooter(copyButtons[1]!)).toHaveClass("opacity-100");
  expect(actionFooter(copyButtons[1]!)).not.toHaveClass(
    "md:opacity-0",
    "md:group-hover:opacity-100",
  );

  view.rerender(messageList(bubbles, false, false));
  expect(actionFooter(screen.getAllByRole("button", { name: "Copy" })[1]!)).toHaveClass(
    "md:opacity-0",
  );
});

it("keeps every action row hover-only when the final message is from the user", () => {
  render(messageList([assistantBubble, bubble], false, true));

  for (const button of screen.getAllByRole("button", { name: "Copy" })) {
    expect(actionFooter(button)).toHaveClass("md:opacity-0");
  }
});

it("keeps a renamed top bubble's row across a history prepend", () => {
  // An assistant bubble is keyed by its first item, so a page that continues
  // the top turn renames it. The row must keep its node: a remount replays the
  // action row's hover fade on every page while older history loads.
  const scrollEl = document.createElement("div");
  Object.defineProperties(scrollEl, {
    scrollTop: { configurable: true, writable: true, value: 0 },
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1_000 },
  });
  scrollEl.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  const transcript = (bubbles: Bubble[]) => (
    <Conversation>
      <ConversationContent>
        <VirtualBubbleList
          bubbles={bubbles}
          scrollEl={scrollEl}
          lastAssistantIndex={bubbles.length - 1}
          showsWorking={false}
          sessionIdle
          conversationId="conv-1"
          hasTasks={false}
          disableVirtualization={false}
          onGeometryChange={vi.fn()}
        />
      </ConversationContent>
    </Conversation>
  );

  const view = render(transcript([assistantBubble]));
  const row = view.container.querySelector<HTMLElement>('[data-index="0"]')!;
  expect(row).toHaveAttribute("data-bubble-key", "assistant:response-1");

  // The page lands an earlier item of the same response: same bubble, new key.
  const renamed: Bubble = {
    ...assistantBubble,
    stableId: "assistant-0",
    items: [
      { kind: "text", itemId: "assistant-0", text: "hello first", final: true },
      ...assistantBubble.items,
    ],
  };
  view.rerender(transcript([renamed]));

  expect(view.container.querySelector('[data-index="0"]')).toBe(row);
  expect(row).toHaveAttribute("data-bubble-key", "assistant:response-1");

  // A genuinely earlier turn is a new row above; the renamed bubble keeps its node.
  view.rerender(transcript([bubble, renamed]));
  expect(view.container.querySelector('[data-index="1"]')).toBe(row);
  expect(view.container.querySelector('[data-index="0"]')).toHaveAttribute(
    "data-bubble-key",
    "user:user-1",
  );
});

it.each([false, true])(
  "holds the reader for an interior recovery insertion, yielding to explicit search=%s",
  (searchOwnsScroll) => {
    const context = createRef<StickToBottomContext>();
    const scrollEl = document.createElement("div");
    Object.defineProperties(scrollEl, {
      scrollTop: { configurable: true, writable: true, value: 450 },
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2000 },
    });
    scrollEl.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    const existing = Array.from({ length: 5 }, (_, index) => ({
      ...bubble,
      itemId: `reader-${index}`,
    }));
    const tree = (bubbles: Bubble[]) => (
      <>
        <textarea aria-label="Recovery draft" defaultValue="Unsent work" />
        <Conversation contextRef={context}>
          <ConversationContent>
            <VirtualBubbleList
              conversationId={undefined}
              bubbles={bubbles}
              scrollEl={scrollEl}
              lastAssistantIndex={-1}
              showsWorking={false}
              sessionIdle
              hasTasks={false}
              disableVirtualization={false}
              onGeometryChange={vi.fn()}
            />
          </ConversationContent>
        </Conversation>
      </>
    );
    const view = render(tree(existing));
    Object.defineProperty(context.current!.state, "scrollTop", {
      configurable: true,
      get: () => scrollEl.scrollTop,
      set: (value: number) => {
        scrollEl.scrollTop = value;
      },
    });
    context.current!.state.isAtBottom = false;
    const release = searchOwnsScroll ? claimTranscriptScrollOwner(scrollEl) : () => {};
    try {
      view.rerender(tree([existing[0], { ...bubble, itemId: "recovered" }, ...existing.slice(1)]));
      expect(scrollEl.scrollTop).toBe(searchOwnsScroll ? 450 : 650);
      expect(screen.getByRole("textbox", { name: "Recovery draft" })).toHaveValue("Unsent work");
    } finally {
      release();
    }
  },
);

it.each(["reader", "wheel", "search", "library"] as const)(
  "retains a visible content anchor through same-bubble recovery, with owner %s",
  async (owner) => {
    const { Virtualizer } =
      await vi.importActual<typeof ReactVirtualModule>("@tanstack/react-virtual");
    const context = createRef<StickToBottomContext>();
    const scrollEl = document.createElement("div");
    Object.defineProperties(scrollEl, {
      scrollTop: { configurable: true, writable: true, value: 170 },
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2000 },
    });
    scrollEl.getBoundingClientRect = () => ({ top: 100, bottom: 600, height: 500 }) as DOMRect;
    const progress: Extract<Bubble, { kind: "assistant" }> = {
      ...assistantBubble,
      responseId: "older-turn",
      stableId: "older-progress",
      lifecycle: "streaming",
      items: [
        {
          kind: "text",
          itemId: "older-progress",
          text: "Checking navigation.",
          phase: "commentary",
          final: true,
        },
      ],
    };
    const user: Bubble = { ...bubble, itemId: "newer-user" };
    const tree = (older: Bubble) => (
      <Conversation contextRef={context}>
        <ConversationContent>
          <VirtualBubbleList
            conversationId={undefined}
            bubbles={[older, user, assistantBubble]}
            scrollEl={scrollEl}
            lastAssistantIndex={2}
            showsWorking={false}
            sessionIdle
            hasTasks={false}
            disableVirtualization={false}
            onGeometryChange={vi.fn()}
          />
        </ConversationContent>
      </Conversation>
    );
    const view = render(tree(progress));
    context.current!.state.isAtBottom = false;
    const anchor = view.container.querySelector<HTMLElement>(
      '[data-user-message-id="newer-user"]',
    )!;
    let growth = 0;
    anchor.getBoundingClientRect = () =>
      ({
        top: 148 + growth - (scrollEl.scrollTop - 170),
        bottom: 180 + growth - (scrollEl.scrollTop - 170),
        height: 32,
      }) as DOMRect;
    // The built-SPA trace leaves only 2.328125px of the older commentary visible.
    // That clipped sliver must not replace the fully visible newer user as the reader anchor.
    const clipped = view.container.querySelector<HTMLElement>(
      '[data-search-item-id="older-progress"]',
    )!;
    clipped.getBoundingClientRect = () =>
      ({ top: 81.53125, bottom: 102.328125, height: 20.796875 }) as DOMRect;
    const row = view.container.querySelector<HTMLElement>('[data-index="0"]')!;
    row.getBoundingClientRect = () => ({ top: -70, bottom: 130, height: 200 }) as DOMRect;
    view.rerender(
      tree({
        ...progress,
        lifecycle: "completed",
        items: [
          ...progress.items,
          {
            kind: "text",
            itemId: "older-final",
            text: "Navigation review is complete.",
            phase: "final_answer",
            final: true,
          },
        ],
      }),
    );
    const rendered = vi.mocked(useVirtualizer).mock.results.at(-1)!.value;
    const instance = new Virtualizer<HTMLElement, HTMLElement>({
      count: 3,
      getScrollElement: () => scrollEl,
      estimateSize: () => 200,
      getItemKey: (index) =>
        ["assistant:older-progress", "user:newer-user", "assistant:response-1"][index],
      initialRect: { width: 800, height: 500 },
      initialOffset: 170,
      observeElementRect: () => {},
      observeElementOffset: () => {},
      scrollToFn: (offset, options) => {
        scrollEl.scrollTop = offset + (options.adjustments ?? 0);
      },
    });
    instance.scrollElement = scrollEl;
    instance.scrollOffset = 170;
    instance.scrollDirection = "backward";
    instance.isScrolling = false;
    instance.itemSizeCache.set("assistant:older-progress", 200);
    instance.getVirtualItems();
    instance.shouldAdjustScrollPositionOnItemSizeChange =
      owner === "library" ? undefined : rendered.shouldAdjustScrollPositionOnItemSizeChange;
    const release = owner === "search" ? claimTranscriptScrollOwner(scrollEl) : () => {};
    try {
      if (owner === "wheel") fireEvent.wheel(scrollEl);
      growth = 34.796875;
      instance.resizeItem(0, 200 + growth);
      expect(scrollEl.scrollTop).toBeCloseTo(owner === "reader" ? 170 + growth : 170);
      if (owner === "reader") {
        expect(Math.abs(anchor.getBoundingClientRect().top - 148)).toBeLessThanOrEqual(1);
        // Compensation exposes the previous text; a subsequent render must keep the reader.
        clipped.getBoundingClientRect = () => ({ top: 110, bottom: 130, height: 20 }) as DOMRect;
        view.rerender(
          tree({
            ...progress,
            lifecycle: "completed",
            items: [
              ...progress.items,
              {
                kind: "text",
                itemId: "older-final",
                text: "Navigation review is complete.",
                phase: "final_answer",
                final: true,
              },
            ],
          }),
        );
        // Completion folding can resize the same row again after its canonical item lands.
        growth = 0;
        instance.resizeItem(0, 200);
        expect(scrollEl.scrollTop).toBeCloseTo(170);
        expect(Math.abs(anchor.getBoundingClientRect().top - 148)).toBeLessThanOrEqual(1);
      }
    } finally {
      release();
    }
  },
);

it("keeps unchanged transcript lists resident across focus changes and scopes native find", async () => {
  vi.useFakeTimers();
  vi.spyOn(chatStore, "ensureConversationStreamed").mockResolvedValue();
  const ids = ["focus-list-a", "focus-list-b"];
  const controllers = ids.map(() => new AbortController());
  for (const [index, id] of ids.entries()) {
    conversationRegistry.acquire(id).setState({
      blocks: [
        {
          type: "user_message",
          userAuthored: true,
          ctx: { itemId: id, responseId: id, agent: null, depth: 0, turn: 0, timestamp: 0 },
          content: [{ type: "input_text", text: `Preserved **${id}**` }],
        },
      ],
      loadingConversation: false,
      sessionStatus: "idle",
      abortController: controllers[index],
    });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transcripts = ids.map((id) => (
    <Transcript
      key={id}
      hostId={null}
      setConversationEl={() => {}}
      containerEl={null}
      scroller={null}
      setScroller={() => {}}
      sendScrollNonce={0}
      hasMoreHistory={false}
      loadingMoreHistory={false}
      isMobileViewport={false}
      showsWorking={false}
      agentsError={null}
      sandboxLaunching={false}
      spacerMeasureRef={{ current: null }}
    />
  ));
  const panes = (focused: number) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {ids.map((id, index) => (
          <scopedChat.ScopedChatStoreProvider
            key={id}
            conversationId={id}
            visible
            focused={index === focused}
          >
            {transcripts[index]}
          </scopedChat.ScopedChatStoreProvider>
        ))}
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(panes(0));
  try {
    expect(view.container.querySelectorAll('[data-index="0"]')).toHaveLength(2);
    const renders = vi.mocked(useVirtualizer).mock.calls.length;
    const streamEnsures = vi.mocked(chatStore.ensureConversationStreamed).mock.calls.length;
    for (let index = 0; index < 6; index++) view.rerender(panes((index + 1) % 2));
    expect(vi.mocked(useVirtualizer).mock.calls.length - renders).toBe(0);
    expect(vi.mocked(chatStore.ensureConversationStreamed).mock.calls.length).toBe(streamEnsures);
    expect(controllers.every((controller) => !controller.signal.aborted)).toBe(true);
    expect(ids.map((id) => conversationRegistry.isVisible(id))).toEqual([true, true]);
    expect(ids.map((id) => conversationRegistry.isFocused(id))).toEqual([true, false]);
    const scopes = ids.map((id) =>
      view.container.querySelector(`[data-conversation-scope="${id}"]`)!,
    );
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    fireEvent.keyDown(window, { key: "ArrowUp", ctrlKey: true, altKey: true });
    expect(scroll).toHaveBeenCalledOnce();
    expect(scopes[0].contains(scroll.mock.contexts.at(-1) as Node)).toBe(true);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(scopes[0].querySelector('[data-index="0"]')).toBeNull();
    expect(scopes[1].querySelector('[data-index="0"]')).not.toBeNull();
    view.rerender(panes(1));
    scroll.mockClear();
    fireEvent.keyDown(window, { key: "ArrowUp", ctrlKey: true, altKey: true });
    expect(scroll).toHaveBeenCalledOnce();
    expect(scopes[1].contains(scroll.mock.contexts.at(-1) as Node)).toBe(true);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(scopes[1].querySelector('[data-index="0"]')).toBeNull();
    expect(scopes[0]).toHaveTextContent("Preserved focus-list-a");
    expect(scopes[1]).toHaveTextContent("Preserved focus-list-b");
    const entry = conversationRegistry.peek(ids[1])!;
    act(() =>
      entry.setState({
        blocks: [
          {
            type: "user_message",
            userAuthored: true,
            ctx: {
              itemId: ids[1],
              responseId: ids[1],
              agent: null,
              depth: 0,
              turn: 0,
              timestamp: 0,
            },
            content: [{ type: "input_text", text: "Updated transcript still renders" }],
          },
        ],
      }),
    );
    expect(scopes[1]).toHaveTextContent("Updated transcript still renders");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
  } finally {
    view.unmount();
    conversationRegistry.clear();
    client.clear();
  }
});

it.each(["false", "reject", "cancel", "dispose"] as const)(
  "releases reader alignment after hydration %s",
  async (outcome) => {
    vi.useFakeTimers();
    const id = `hydration-${outcome}`;
    useChatStore.setState({ conversationId: id });
    rememberTranscriptReaderCheckpoint(id, {
      snapshot: {
        atBottom: false,
        anchorKey: "user:user-1",
        anchorItemId: "user-1",
        anchorOffset: -123,
        fallbackOffset: 123,
      },
      loadedMinPosition: 0,
    });
    const scrollEl = document.createElement("div");
    Object.defineProperties(scrollEl, {
      scrollTop: { configurable: true, writable: true, value: 0 },
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2000 },
    });
    let resolve!: (ready: boolean) => void;
    let reject!: (error: Error) => void;
    const hydration = new Promise<boolean>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const handler = vi.fn((_request: TranscriptReaderRestoreRequest) => hydration);
    const release = setTranscriptReaderHydrator(handler);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(list(false, scrollEl, vi.fn(), false, [bubble], id));
    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(handler).toHaveBeenCalledTimes(1);
      const signal = handler.mock.calls[0]![0]?.signal;
      await act(async () => {
        if (outcome === "dispose") view.unmount();
        else if (outcome === "cancel") fireEvent.wheel(scrollEl);
        else if (outcome === "reject") reject(new Error("hydration failed"));
        else resolve(false);
      });
      expect(signal?.aborted).toBe(true);
      scrollEl.scrollTop = 456;
      fireEvent.scroll(scrollEl);
      if (outcome !== "dispose")
        expect(readTranscriptReaderCheckpoint(id)?.snapshot).toMatchObject({ fallbackOffset: 456 });
      await act(async () => {
        resolve(true);
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(scrollEl.scrollTop).toBe(456);
      expect(errors).toHaveBeenCalledTimes(outcome === "reject" ? 1 : 0);
    } finally {
      view.unmount();
      release();
    }
  },
);

it("restores search original-source choices when canonical text arrives after reopening", async () => {
  const id = "delayed-original-reader";
  const source = "[label](https://example.test/needle)";
  rememberTranscriptReaderCheckpoint(id, {
    originalItemIds: ["source-item"],
    revealedItemIds: ["source-item"],
  });
  useChatStore.setState({
    conversationId: id,
    blocks: [],
    pendingUserMessages: [],
    activeResponse: null,
    sessionStatus: "idle",
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Transcript
          hostId={null}
          setConversationEl={() => {}}
          containerEl={null}
          scroller={null}
          setScroller={() => {}}
          sendScrollNonce={0}
          hasMoreHistory={false}
          loadingMoreHistory={false}
          isMobileViewport
          showsWorking={false}
          agentsError={null}
          sandboxLaunching={false}
          spacerMeasureRef={{ current: null }}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree);
  try {
    expect(readTranscriptReaderCheckpoint(id)?.originalItemIds).toEqual(["source-item"]);
    act(() =>
      useChatStore.setState({
        blocks: [
          {
            type: "text_done",
            ctx: {
              itemId: "source-item",
              position: 0,
              responseId: "source-response",
              agent: null,
              depth: 0,
              turn: 0,
              timestamp: 0,
            },
            fullText: source,
            hasCodeBlocks: false,
            phase: "final_answer",
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-search-item-id="source-item"] [data-chat-plain-text]'),
      ).toHaveTextContent(source),
    );
    expect(readTranscriptReaderCheckpoint(id)?.originalItemIds).toEqual(["source-item"]);
  } finally {
    view.unmount();
    client.clear();
  }
});

it("restores the actual reader offset under a new view ID after the last mounted and Undo owners expire", async () => {
  vi.useFakeTimers();
  const id = "reader-after-undo-expiry";
  useChatStore.setState({ conversationId: id });
  const oldEntry = conversationRegistry.peek(id)!;
  const releaseUndo = conversationRegistry.retainHistory(id);
  const bubbles = Array.from({ length: 8 }, (_, index) => ({
    ...bubble,
    itemId: `expiry-${index}`,
  }));
  const surface = () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      scrollTop: { configurable: true, writable: true, value: 0 },
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2000 },
    });
    return element;
  };
  const tree = (viewId: string, element: HTMLElement) => (
    <ResourceViewIdContext.Provider value={viewId}>
      {list(false, element, vi.fn(), false, bubbles, id)}
    </ResourceViewIdContext.Provider>
  );
  const oldSurface = surface();
  const old = render(tree("expired-view", oldSurface));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(64);
  });
  oldSurface.scrollTop = 333;
  fireEvent.scroll(oldSurface);
  const saved = readTranscriptReaderCheckpoint(id, "expired-view")!.snapshot;
  old.unmount();
  conversationRegistry.setActive(null);
  for (let i = 0; i < 100; i++) conversationRegistry.acquire(`expiry-pressure-${i}`);
  expect(oldEntry.disposed).toBe(false);
  releaseUndo();
  await act(async () => {
    await Promise.resolve();
  });
  expect(oldEntry.disposed).toBe(true);
  useChatStore.setState({ conversationId: null });
  useChatStore.setState({ conversationId: id });
  const nextSurface = surface();
  const next = render(tree("new-view-id", nextSurface));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(64);
    });
    expect(nextSurface.scrollTop).toBe(333);
    expect(readTranscriptReaderCheckpoint(id, "new-view-id")?.snapshot).toEqual(saved);
    expect(conversationRegistry.peek(id)).not.toBe(oldEntry);
  } finally {
    next.unmount();
    conversationRegistry.clear();
  }
});
