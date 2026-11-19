// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useSyncExternalStore } from "react";
import { toast } from "./notifications";

export const CHAT_SCROLL_KEY = "triune:chat-scroll";
export type ChatScrollPreference = "stay" | "follow";
const changeEvent = "triune:chat-scroll-change";

export function readChatScrollPreference(): ChatScrollPreference {
  try {
    return localStorage.getItem(CHAT_SCROLL_KEY) === "stay" ? "stay" : "follow";
  } catch {
    return "follow";
  }
}

export function writeChatScrollPreference(value: ChatScrollPreference) {
  try {
    localStorage.setItem(CHAT_SCROLL_KEY, value);
  } catch {
    toast.error("Could not save chat scrolling. Browser storage is unavailable.");
    return;
  }
  window.dispatchEvent(new Event(changeEvent));
}

export function useChatScrollPreference() {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("storage", listener);
      window.addEventListener(changeEvent, listener);
      return () => {
        window.removeEventListener("storage", listener);
        window.removeEventListener(changeEvent, listener);
      };
    },
    readChatScrollPreference,
    () => "follow" as const,
  );
}

export const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 24;

export function isTranscriptAtBottom(viewport: HTMLElement): boolean {
  return (
    viewport.clientHeight > 0 &&
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <=
      TRANSCRIPT_BOTTOM_THRESHOLD_PX
  );
}

/** Remember the reader's edge before the browser lays out the next transcript. */
export function observeChatScroll(
  viewport: HTMLElement,
  content: HTMLElement,
  follow: boolean,
  onPosition?: (atBottom: boolean) => void,
) {
  const extent = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  let previousExtent = extent();
  let previousTop = viewport.scrollTop;
  let atEdge = isTranscriptAtBottom(viewport);
  const position = () => {
    if (!viewport.clientHeight) return;
    const nextExtent = extent();
    // A layout shrink can clamp scrollTop and dispatch scroll before resize.
    if (nextExtent === previousExtent || viewport.scrollTop !== Math.min(previousTop, nextExtent)) {
      atEdge = previousExtent - viewport.scrollTop <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
      previousTop = viewport.scrollTop;
    }
    onPosition?.(atEdge);
  };
  const layout = () => {
    if (!viewport.clientHeight) return;
    const nextExtent = extent();
    // A scroll can also precede delivery of its event.
    if (viewport.scrollTop !== Math.min(previousTop, nextExtent))
      atEdge = previousExtent - viewport.scrollTop <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
    if (follow && atEdge && viewport.scrollTop !== nextExtent) viewport.scrollTop = nextExtent;
    previousExtent = nextExtent;
    previousTop = viewport.scrollTop;
    atEdge = isTranscriptAtBottom(viewport);
    onPosition?.(atEdge);
  };
  const observer = new ResizeObserver(layout);
  observer.observe(content);
  observer.observe(viewport);
  // Equal-height replacements do not produce a resize.
  const mutations = new MutationObserver(layout);
  mutations.observe(content, { childList: true, subtree: true, characterData: true });
  viewport.addEventListener("scroll", position, { passive: true });
  onPosition?.(atEdge);
  return () => {
    mutations.disconnect();
    observer.disconnect();
    viewport.removeEventListener("scroll", position);
  };
}
