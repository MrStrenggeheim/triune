// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { inlinePreviewHeight, useInlinePreviewBoundary } from "./inlinePreviewBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  [100, 500, 0, 900, 240],
  [0, 1200, 0, 800, 480],
  [100, 700, 200, 300, 180],
  [800, 1000, 0, 600, 0],
])(
  "bounds view %s–%s against visible viewport %s/%s",
  (top, bottom, viewportTop, viewportHeight, expected) => {
    expect(inlinePreviewHeight({ top, bottom }, viewportTop, viewportHeight)).toBe(expected);
  },
);

it("tracks the nearest split view and visual viewport without touching content/scroll", () => {
  const observers: ResizeObserverCallback[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  let viewHeight = 400;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return {
      top: 100,
      bottom: this.hasAttribute("data-chat-surface") ? 100 + viewHeight : 800,
    } as DOMRect;
  });
  function Subject({ inline = true }: { inline?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const style = useInlinePreviewBoundary(ref, inline);
    return (
      <div data-workbench-view="chat">
        <div data-chat-surface>
          <div ref={ref} data-testid="preview" style={style}>
            <input defaultValue="retained" />
          </div>
        </div>
      </div>
    );
  }
  const { rerender } = render(<Subject />);
  const preview = screen.getByTestId("preview");
  const input = preview.querySelector("input");
  preview.scrollTop = 80;
  expect(preview.style.maxHeight).toContain("240px");
  viewHeight = 300;
  act(() => observers[0]([], {} as ResizeObserver));
  expect(preview.style.maxHeight).toContain("180px");
  viewport.height = 250;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(preview.style.maxHeight).toContain("90px");
  expect(preview.style.maxHeight).toContain("--omnigent-safe-bottom");
  expect(preview.querySelector("input")).toBe(input);
  expect(preview.scrollTop).toBe(80);
  rerender(<Subject inline={false} />);
  expect(preview.style.maxHeight).toBe("");
  expect(disconnect).toHaveBeenCalledOnce();
});
