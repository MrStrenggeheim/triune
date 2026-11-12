// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KeepBottomOnViewportResize, ScrollToBottomOnSend } from "./chatBubbleParts";

const context = vi.hoisted(() => ({
  scrollRef: { current: null as HTMLElement | null },
  state: { isAtBottom: true, escapedFromLock: false },
  scrollToBottom: vi.fn(),
}));
vi.mock("use-stick-to-bottom", () => ({ useStickToBottomContext: () => context }));

let resize: () => void;
let frames: Map<number, FrameRequestCallback>;
let metrics: { top: number; height: number };
beforeEach(() => {
  context.state.isAtBottom = true;
  context.state.escapedFromLock = false;
  context.scrollToBottom.mockReset().mockImplementation(() => {
    context.state.isAtBottom = true;
  });
  metrics = { top: 1300, height: 700 };
  const el = document.createElement("div");
  Object.defineProperties(el, {
    scrollTop: {
      get: () => metrics.top,
      set: (top: number) => {
        metrics.top = top;
      },
    },
    clientHeight: { get: () => metrics.height },
    scrollHeight: { get: () => 2000 },
  });
  context.scrollRef.current = el;
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

it("rechecks reader escape before a queued resize pin without waiting for scroll delivery", () => {
  render(<KeepBottomOnViewportResize />);
  metrics.height = 650;
  act(() => resize());
  expect(context.scrollToBottom).toHaveBeenCalledOnce();
  context.state.isAtBottom = false;
  context.state.escapedFromLock = true;
  metrics.top = 800;
  flushFrames();
  expect(metrics.top).toBe(800);
  expect(context.scrollToBottom).toHaveBeenCalledOnce();
});

it("does not reclassify an escaped reader as locked at the physical bottom", () => {
  render(<KeepBottomOnViewportResize />);
  context.state.isAtBottom = false;
  context.state.escapedFromLock = true;
  fireEvent.scroll(context.scrollRef.current!);
  context.state.isAtBottom = true;
  context.state.escapedFromLock = false;
  metrics.height = 650;
  act(() => resize());
  expect(metrics.top).toBe(1300);
  expect(context.scrollToBottom).not.toHaveBeenCalled();
});

it("retains intentional bottom-follow through a viewport resize", () => {
  render(<KeepBottomOnViewportResize />);
  metrics.height = 650;
  act(() => resize());
  flushFrames();
  expect(metrics.top).toBe(1349);
  expect(context.scrollToBottom).toHaveBeenCalledTimes(2);
});

it("sends with intentional bottom-follow and yields its queued pin to a reader escape", () => {
  context.state.isAtBottom = false;
  context.state.escapedFromLock = true;
  render(<ScrollToBottomOnSend nonce={1} />);
  expect(context.state.isAtBottom).toBe(true);
  expect(context.state.escapedFromLock).toBe(false);
  context.state.isAtBottom = false;
  context.state.escapedFromLock = true;
  flushFrames();
  expect(context.scrollToBottom).toHaveBeenCalledOnce();
});
