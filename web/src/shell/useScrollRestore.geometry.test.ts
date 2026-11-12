// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { measureElement, Virtualizer } from "@tanstack/react-virtual";
import { afterEach, expect, it, vi } from "vitest";
import {
  measureRetainedElement,
  observeRetainedElementRect,
  remeasureRetainedElements,
} from "./useScrollRestore";

// Exercise the installed geometry/cache implementation, rather than the shared jsdom row stub.
vi.unmock("@tanstack/react-virtual");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function virtualizer() {
  return new Virtualizer<HTMLElement, HTMLElement>({
    count: 220,
    getScrollElement: () => null,
    estimateSize: () => 25,
    scrollToFn: vi.fn(),
    observeElementRect: () => {},
    observeElementOffset: () => {},
    onChange: vi.fn(),
  });
}

it("profiles hidden zero measurements without corrupting retained row geometry", () => {
  const results = [];
  for (const measure of [measureElement<HTMLElement>, measureRetainedElement]) {
    const instance = virtualizer();
    const before = instance.getTotalSize();
    const row = document.createElement("div");
    const entry = {
      borderBoxSize: [{ blockSize: 0, inlineSize: 0 }],
    } as unknown as ResizeObserverEntry;
    let zeroWrites = 0;
    for (let index = 0; index < 186; index++) {
      row.setAttribute("data-index", String(index));
      const size = measure(row, entry, instance);
      if (size === 0) zeroWrites++;
      instance.resizeItem(index, size);
    }
    results.push({
      before,
      after: instance.getTotalSize(),
      zeroWrites,
      updates: vi.mocked(instance.options.onChange).mock.calls.length,
    });
  }
  process.stdout.write(
    `hidden row cache profile (native / retained): ${JSON.stringify(results)}\n`,
  );
  expect(results[0]).toEqual({ before: 5500, after: 850, zeroWrites: 186, updates: 186 });
  expect(results[1]).toEqual({ before: 5500, after: 5500, zeroWrites: 0, updates: 0 });
});

it("keeps zero-size viewport observations out of the virtual range", () => {
  let resize: ResizeObserverCallback;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
    },
  );
  const instance = virtualizer();
  const el = document.createElement("div");
  Object.defineProperties(el, { offsetWidth: { value: 320 }, offsetHeight: { value: 500 } });
  instance.scrollElement = el;
  instance.targetWindow = window;
  const report = vi.fn();
  const dispose = observeRetainedElementRect(instance, report);
  for (const blockSize of [0, 600])
    resize!(
      [
        {
          borderBoxSize: [{ blockSize, inlineSize: blockSize ? 320 : 0 }],
        } as unknown as ResizeObserverEntry,
      ],
      {} as ResizeObserver,
    );
  expect(report.mock.calls).toEqual([[{ width: 320, height: 500 }], [{ width: 320, height: 600 }]]);
  dispose?.();
});

it("remeasures mounted visible rows on resume, retaining hidden cached rows", () => {
  const instance = virtualizer();
  instance.getTotalSize();
  const visible = document.createElement("div");
  const hidden = document.createElement("div");
  document.body.append(visible, hidden);
  visible.dataset.index = "0";
  hidden.dataset.index = "1";
  vi.spyOn(visible, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 320, 32),
  ] as unknown as DOMRectList);
  vi.spyOn(visible, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 32));
  instance.elementsCache.set(0, visible);
  instance.elementsCache.set(1, hidden);
  remeasureRetainedElements(instance);
  expect(instance.itemSizeCache.get(0)).toBe(32);
  expect(instance.itemSizeCache.has(1)).toBe(false);
  visible.remove();
  hidden.remove();
});
