// Modified for Triune.
import { useConversationChatStore } from "@/workbench/ScopedChatStore";
import { useContext, useEffect, useRef, useState } from "react";
import { releaseConversationScrollLock } from "@/components/ai-elements/conversation";
import type { Bubble } from "@/lib/renderItems";
import { findMessageElement } from "@/lib/messageDeepLink";
import { toast } from "@/lib/notifications";
import { ApiError } from "@/lib/sessionsApi";
import type { ContextSearchTarget } from "@/shell/contextSearch/types";
import {
  CHAT_SEARCH_BODY_SELECTOR,
  ChatSearchRevealContext,
  chatQueryRanges,
  chatSearchSources,
  clearChatSearchHighlights,
  paintChatSearchHighlights,
  searchSourceElement,
  sourceOccurrenceRange,
  type SearchSource,
  type ChatSearchRevealState,
} from "@/lib/chatSearchHighlights";
import "@/components/chat/chatSearchHighlights.css";

let highlightOwner: object | null = null;
const LOAD_BUDGET_MS = 15_000;
const MAX_HISTORY_PAGES = 40;
const RENDER_BUDGET_MS = 4_000;
const SETTLE_MS = 120;
const CORRECTION_BUDGET_MS = 1_000;

export interface ChatSearchResolution {
  target: ContextSearchTarget;
  status: "resolved" | "unavailable";
}

export interface ChatSearchHighlightOptions {
  conversationId: string | null;
  query: string;
  target: ContextSearchTarget | null;
  onResolved?: (result: ChatSearchResolution) => void;
  container: Element | null;
  scrollElement: HTMLElement | null;
  bubbles: readonly Bubble[];
  /** Authoritative loaded items before presentation filtering. */
  sources?: readonly SearchSource[];
  reveal?: ChatSearchRevealState;
  ensureMessageVisible: (id: string) => boolean;
  ready: boolean;
  rangeNonce?: number;
}

function sourceRange(options: ChatSearchHighlightOptions): Range | null {
  const { container, target } = options;
  if (!container || !target || target.conversationId !== options.conversationId) return null;
  const source = (options.sources ?? chatSearchSources(options.bubbles)).find(
    (value) => value.itemId === target.itemId,
  );
  if (!source || !validSource(source, target)) return null;
  const element = searchSourceElement(container, source);
  return element
    ? sourceOccurrenceRange(
        element,
        source.text,
        (target.textStart ?? 0) + target.range.start,
        (target.textStart ?? 0) + target.range.end,
      )
    : null;
}

function validSource(source: SearchSource, target: ContextSearchTarget): boolean {
  const from = target.textStart ?? 0;
  return (
    Number.isInteger(from) &&
    from >= 0 &&
    Number.isInteger(target.range.start) &&
    Number.isInteger(target.range.end) &&
    target.range.start >= 0 &&
    target.range.end > target.range.start &&
    target.range.end <= target.sourceText.length &&
    source.text.slice(from, from + target.sourceText.length) === target.sourceText
  );
}

/** A refresh paints only; each explicit activation owns one cancellable reveal. */
export function useChatSearchHighlights(options: ChatSearchHighlightOptions): void {
  const useChatStore = useConversationChatStore();
  const contextReveal = useContext(ChatSearchRevealContext);
  const reveal = options.reveal ?? contextReveal;
  const latest = useRef({ options, reveal });
  latest.current = { options, reveal };
  const owner = useRef({});
  const [revision, setRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const completed = useRef<string | null>(null);
  const {
    container,
    conversationId,
    query,
    target: selectedTarget,
    ready,
    scrollElement,
  } = options;
  const loadingConversation = useChatStore((state) => state.loadingConversation);
  const activation =
    selectedTarget && query && selectedTarget.conversationId === conversationId
      ? JSON.stringify([
          conversationId,
          selectedTarget.itemId,
          selectedTarget.range.start,
          selectedTarget.range.end,
          selectedTarget.textStart ?? 0,
          selectedTarget.requestId,
          query,
        ])
      : null;

  useEffect(() => {
    if (!container || !query) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setRevision((value) => value + 1);
      });
    });
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [container, query]);

  useEffect(() => {
    if (!container || !query) {
      if (highlightOwner === owner.current) paintChatSearchHighlights([], null);
      return;
    }
    // An inactive retained chat cannot clear another pane's selected occurrence.
    if (!selectedTarget && highlightOwner && highlightOwner !== owner.current) return;
    const ranges = Array.from(
      container.querySelectorAll(`[data-message-id] :is(${CHAT_SEARCH_BODY_SELECTOR})`),
    ).flatMap((element) => chatQueryRanges(element, query));
    highlightOwner = owner.current;
    paintChatSearchHighlights(ranges, sourceRange(options));
  }, [options, revision, container, query, selectedTarget]);

  useEffect(
    () => () => {
      if (highlightOwner !== owner.current) return;
      highlightOwner = null;
      clearChatSearchHighlights();
    },
    [container, conversationId],
  );

  useEffect(() => {
    if (!activation) {
      completed.current = null;
      return;
    }
    const key = `${activation}:${retry}`;
    const { target, query: activationQuery } = latest.current.options;
    if (!container || !target || !ready || loadingConversation || completed.current === key) return;
    let cancelled = false;
    let disposed = false;
    let timer = 0;
    let wake: (() => void) | undefined;
    const pause = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = window.setTimeout(resolve, 32);
      });
    const cancel = () => {
      cancelled = true;
      completed.current = key;
      clearTimeout(timer);
      wake?.();
    };
    const interrupt = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      )
        return;
      if (
        event instanceof KeyboardEvent &&
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      cancel();
    };
    const scroller = scrollElement ?? container;
    for (const event of ["wheel", "touchstart", "pointerdown"]) {
      scroller.addEventListener(event, interrupt, { passive: true });
    }
    scroller.ownerDocument.addEventListener("keydown", interrupt);
    releaseConversationScrollLock(scroller);
    // Stop a deep-link's already-started native smooth scroll as search takes ownership.
    scrollElement?.scrollTo?.({ top: scrollElement.scrollTop, behavior: "instant" });
    const notify = (message: string, retryHistory = false) => {
      if (cancelled) return;
      completed.current = key;
      cancelled = true;
      toast.error(message, {
        id: `chat-search:${conversationId}`,
        action: {
          label: "Retry",
          onClick: () => {
            if (disposed) return;
            const current = latest.current.options;
            if (
              current.conversationId === conversationId &&
              current.query === activationQuery &&
              current.target?.requestId === target.requestId &&
              current.target?.itemId === target.itemId &&
              current.target?.range.start === target.range.start &&
              current.target?.range.end === target.range.end
            ) {
              if (retryHistory) useChatStore.setState({ hasMoreHistory: true });
              setRetry((value) => value + 1);
            }
          },
        },
      });
    };
    // Each poll depends on the preceding load, React commit or measurement.
    /* oxlint-disable no-await-in-loop */
    const run = async () => {
      const loadDeadline = performance.now() + LOAD_BUDGET_MS;
      let pages = 0;
      let loadingPage = false;
      let previousCursor: string | null | undefined;
      let renderDeadline: number | undefined;
      let mountedRow: string | undefined;
      let mountAttempts = 0;
      let lastMountAt = 0;
      let revealed = false;
      let signature = "";
      let stableSince = performance.now();
      let correctionDeadline: number | undefined;
      let alignedSignature = "";
      let corrections = 0;
      for (let poll = 0; poll < 1000; poll++) {
        if (cancelled) return;
        const current = latest.current.options;
        const state = useChatStore.getState();
        const source = (current.sources ?? chatSearchSources(current.bubbles)).find(
          (value) => value.itemId === target.itemId,
        );
        if (!source) {
          if (performance.now() >= loadDeadline || pages >= MAX_HISTORY_PAGES) {
            notify("Couldn’t finish loading this message.", true);
            return;
          }
          if (loadingPage || state.loadingMoreHistory) {
            await pause();
            continue;
          }
          if (previousCursor !== undefined && state.oldestItemId === previousCursor) {
            // The store also swallows page failures. A stalled cursor is retryable,
            // never evidence that this stored item was deleted.
            notify("Couldn’t load this message.", true);
            return;
          }
          if (!state.hasMoreHistory) {
            notify("This message is no longer available in this conversation.");
            return;
          }
          previousCursor = state.oldestItemId;
          pages += 1;
          // Do not await an unbounded transport promise. Store updates wake the next poll.
          loadingPage = true;
          void state.loadMoreHistory().then(
            () => {
              loadingPage = false;
            },
            (error: unknown) => {
              loadingPage = false;
              if (error instanceof ApiError && error.status === 403)
                notify("You no longer have access to this conversation.");
              else if (error instanceof ApiError && error.status === 404)
                notify("This conversation is no longer available.");
              else notify("Couldn’t load this message.", true);
            },
          );
          await pause();
          continue;
        }
        if (!validSource(source, target)) {
          notify("This message changed. Search again to find its current text.");
          return;
        }
        renderDeadline ??= performance.now() + RENDER_BUDGET_MS;
        if (performance.now() >= (correctionDeadline ?? renderDeadline)) return;
        const revealState = latest.current.reveal;
        if (revealState && !revealed) {
          revealed = true;
          revealState.reveal(source.itemId);
          await pause();
          continue;
        }
        const row = findMessageElement(source.rowId, container);
        if (!row) {
          if (
            mountedRow !== source.rowId ||
            (mountAttempts < 3 && performance.now() - lastMountAt > 250)
          ) {
            mountedRow = source.rowId;
            mountAttempts += 1;
            lastMountAt = performance.now();
            current.ensureMessageVisible(source.rowId);
          }
        } else {
          // Compatibility for bubble owners without the reveal context.
          const expand = Array.from(row.querySelectorAll("button")).find((button) =>
            button.textContent?.startsWith("Show full prompt ("),
          );
          if (expand) {
            expand.click();
            await pause();
            continue;
          }
        }
        const range = sourceRange(current);
        if (
          row &&
          !range &&
          revealState &&
          revealState.originalSources.get(source.itemId) !== source.text
        ) {
          revealState.showOriginal(source.itemId, source.text);
          await pause();
          continue;
        }
        if (!range) {
          // Closed/unmounted content remains render-pending. A future activation
          // can retry; it never creates an unavailable verdict for a valid item.
          if (performance.now() >= renderDeadline) return;
          await pause();
          continue;
        }
        const bounds = range.getBoundingClientRect();
        const viewport = scrollElement?.getBoundingClientRect();
        if (bounds.height <= 0 || (viewport && viewport.height <= 0)) {
          if (performance.now() >= renderDeadline) return;
          await pause();
          continue;
        }
        const measured = JSON.stringify([
          bounds.top - (viewport?.top ?? 0) + (scrollElement?.scrollTop ?? 0),
          bounds.height,
          viewport?.height,
          scrollElement?.scrollHeight,
        ]);
        const now = performance.now();
        if (measured !== signature) {
          signature = measured;
          stableSince = now;
        }
        if (now - stableSince >= SETTLE_MS && alignedSignature !== signature) {
          if (scrollElement && viewport) {
            const delta = bounds.top - viewport.top - (viewport.height - bounds.height) / 2;
            if (Math.abs(delta) > 1) scrollElement.scrollBy({ top: delta, behavior: "auto" });
          }
          alignedSignature = signature;
          corrections += 1;
          correctionDeadline ??= now + CORRECTION_BUDGET_MS;
          stableSince = now;
        }
        if (
          correctionDeadline &&
          (now - stableSince >= SETTLE_MS || now >= correctionDeadline || corrections >= 3)
        ) {
          completed.current = key;
          latest.current.options.onResolved?.({ target, status: "resolved" });
          return;
        }
        if (!correctionDeadline && now >= renderDeadline) return;
        await pause();
      }
    };
    /* oxlint-enable no-await-in-loop */
    void run();
    return () => {
      disposed = true;
      cancelled = true;
      clearTimeout(timer);
      wake?.();
      for (const event of ["wheel", "touchstart", "pointerdown"]) {
        scroller.removeEventListener(event, interrupt);
      }
      scroller.ownerDocument.removeEventListener("keydown", interrupt);
    };
  }, [
    activation,
    retry,
    container,
    scrollElement,
    ready,
    loadingConversation,
    conversationId,
    useChatStore,
  ]);
}
