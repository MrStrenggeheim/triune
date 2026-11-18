// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, expect, it, vi } from "vitest";
import {
  CHAT_SCROLL_KEY,
  observeChatScroll,
  readChatScrollPreference,
  writeChatScrollPreference,
} from "@/lib/chatScrollPreference";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(CHAT_SCROLL_KEY);
});

it("defaults to stay and restores an explicit choice", () => {
  expect(readChatScrollPreference()).toBe("stay");
  writeChatScrollPreference("follow");
  expect(readChatScrollPreference()).toBe("follow");
});

it.each([false, true])(
  "keeps reading position through content and viewport changes (follow %s)",
  (follow) => {
    let resize!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          resize = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const viewport = document.createElement("div");
    let contentHeight = 1000;
    let viewportHeight = 400;
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => contentHeight },
      clientHeight: { get: () => viewportHeight },
    });
    viewport.scrollTop = 600;
    const stop = observeChatScroll(viewport, document.createElement("div"), follow);
    contentHeight += 200;
    resize();
    expect(viewport.scrollTop).toBe(follow ? 800 : 600);
    viewport.scrollTop = 700;
    viewportHeight -= 40;
    resize();
    expect(viewport.scrollTop).toBe(700);
    viewport.scrollTop = 840;
    contentHeight += 10;
    resize();
    expect(viewport.scrollTop).toBe(follow ? 850 : 840);
    stop();
    expect(disconnect).toHaveBeenCalledOnce();
  },
);
