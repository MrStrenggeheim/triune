// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useSyncExternalStore } from "react";
import { toast } from "./notifications";

export const CHAT_SCROLL_KEY = "triune:chat-scroll";
export type ChatScrollPreference = "stay" | "follow";
const changeEvent = "triune:chat-scroll-change";

export function readChatScrollPreference(): ChatScrollPreference {
  try {
    return localStorage.getItem(CHAT_SCROLL_KEY) === "follow" ? "follow" : "stay";
  } catch {
    return "stay";
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
    () => "stay" as const,
  );
}

/** Compare with the previous viewport extent so content growth cannot hide a reader's escape. */
export function observeChatScroll(
  viewport: HTMLElement,
  content: HTMLElement,
  follow: boolean,
  onPosition?: (atBottom: boolean) => void,
) {
  const extent = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  let previousExtent = extent();
  const publish = () => onPosition?.(extent() - viewport.scrollTop <= 1);
  const resize = () => {
    if (!viewport.clientHeight) return;
    const nextExtent = extent();
    if (follow && nextExtent > previousExtent && viewport.scrollTop >= previousExtent - 1) {
      viewport.scrollTop = nextExtent;
    }
    previousExtent = nextExtent;
    publish();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(content);
  observer.observe(viewport);
  viewport.addEventListener("scroll", publish, { passive: true });
  publish();
  return () => {
    observer.disconnect();
    viewport.removeEventListener("scroll", publish);
  };
}
