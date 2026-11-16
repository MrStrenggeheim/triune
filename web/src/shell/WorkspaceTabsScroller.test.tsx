// Modified for Triune.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabsScroller } from "./WorkspaceTabsScroller";

const resizeCallbacks = new Set<ResizeObserverCallback>();
const resizeObservers: { nodes: Element[]; disconnected: boolean }[] = [];
let availableWidth = 300;
let tabsWidth = 300;

function Harness({ tabs = 1 }: { tabs?: number }) {
  const [overflow, setOverflow] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  return (
    <>
      <WorkspaceTabsScroller onOverflowChange={setOverflow} overflowControlRef={picker}>
        {Array.from({ length: tabs }, (_, index) => (
          <button type="button" key={index}>
            {index}
          </button>
        ))}
      </WorkspaceTabsScroller>
      {overflow && (
        <div ref={picker} data-testid="picker">
          Select panel
        </div>
      )}
    </>
  );
}

function setupGeometry() {
  availableWidth = 300;
  tabsWidth = 300;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      record = { nodes: [] as Element[], disconnected: false };
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeCallbacks.add(callback);
        resizeObservers.push(this.record);
      }
      observe(element: Element) {
        this.record.nodes.push(element);
      }
      disconnect() {
        this.record.disconnected = true;
        resizeCallbacks.delete(this.callback);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-workspace-tabs-viewport")
      ? availableWidth - (screen.queryByTestId("picker") ? 28 : 0)
      : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-workspace-tabs-content") ||
      this.hasAttribute("data-workspace-tabs-viewport")
      ? tabsWidth
      : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === "picker" ? 28 : 0;
  });
}

function resize(width: number) {
  availableWidth = width;
  act(() => {
    for (const callback of [...resizeCallbacks]) callback([], {} as ResizeObserver);
  });
}

afterEach(() => {
  cleanup();
  resizeCallbacks.clear();
  resizeObservers.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceTabsScroller", () => {
  it("omits unused reporting observation and releases it when its consumer disappears", () => {
    setupGeometry();
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const report = vi.fn();
    const tabs = (reporting: boolean) => (
      <WorkspaceTabsScroller onOverflowChange={reporting ? report : undefined}>
        <button type="button">Tab</button>
      </WorkspaceTabsScroller>
    );
    const view = render(tabs(false));
    expect(resizeObservers).toHaveLength(1);
    view.rerender(tabs(true));
    expect(resizeCallbacks.size).toBe(2);
    expect(report).toHaveBeenLastCalledWith(false);
    view.rerender(tabs(false));
    expect(resizeCallbacks.size).toBe(1);
    report.mockClear();
    resize(200);
    expect(report).not.toHaveBeenCalled();
    view.unmount();
    expect(resizeCallbacks.size).toBe(0);
    expect(resizeObservers.every((observer) => observer.disconnected)).toBe(true);
    const resizeHandlers = added.mock.calls
      .filter(([type]) => type === "resize")
      .map(([, handler]) => handler);
    const removedHandlers = removed.mock.calls
      .filter(([type]) => type === "resize")
      .map(([, handler]) => handler);
    expect(removedHandlers).toHaveLength(resizeHandlers.length);
    expect(removedHandlers).toEqual(expect.arrayContaining(resizeHandlers));
  });

  it("reveals a changed nearest-tab selection without replacing observation or fighting manual scroll", () => {
    setupGeometry();
    const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
    const tabs = (selected: string) => (
      <WorkspaceTabsScroller activeKey={selected}>
        {["First", "Second"].map((label) => (
          <button type="button" key={label} aria-selected={selected === label}>
            {label}
          </button>
        ))}
      </WorkspaceTabsScroller>
    );
    const view = render(tabs("First"));
    const installed = resizeObservers.length;
    view.rerender(tabs("Second"));
    expect(reveal.mock.contexts.at(-1)).toBe(screen.getByRole("button", { name: "Second" }));
    reveal.mockClear();
    const viewport = view.container.querySelector<HTMLElement>("[data-workspace-tabs-viewport]")!;
    viewport.scrollLeft = 45;
    view.rerender(tabs("Second"));
    expect(reveal).not.toHaveBeenCalled();
    expect(viewport.scrollLeft).toBe(45);
    expect(resizeObservers).toHaveLength(installed);
  });

  it("keeps reporting observers through tab changes and font/content resize delivery", () => {
    setupGeometry();
    const report = vi.fn();
    const tabs = (label: string) => (
      <WorkspaceTabsScroller onOverflowChange={report}>
        <button type="button">{label}</button>
      </WorkspaceTabsScroller>
    );
    const view = render(tabs("First"));
    const installed = resizeObservers.length;
    tabsWidth = 450;
    view.rerender(tabs("Longer tab"));
    expect(report).toHaveBeenLastCalledWith(true);
    expect(resizeObservers).toHaveLength(installed);
    tabsWidth = 200;
    const content = view.container.querySelector("[data-workspace-tabs-content]")!;
    expect(resizeObservers.every((observer) => observer.nodes.includes(content))).toBe(true);
    resize(300);
    expect(report).toHaveBeenLastCalledWith(false);
    tabsWidth = 500;
    resize(300);
    expect(report).toHaveBeenLastCalledWith(true);
    expect(resizeObservers).toHaveLength(installed);
    view.unmount();
    expect(resizeCallbacks.size).toBe(0);
  });

  it("shows overflow only when tabs cannot fit and releases the picker reservation on resize", () => {
    setupGeometry();
    render(<Harness />);
    expect(screen.queryByTestId("picker")).toBeNull();
    resize(299);
    expect(screen.getByTestId("picker")).toBeInTheDocument();
    resize(299);
    expect(screen.getByTestId("picker")).toBeInTheDocument();
    // Tabs fit if the picker is removed, but would still overflow if its width
    // remained reserved. Repeated observer delivery must settle with it hidden.
    resize(310);
    expect(screen.queryByTestId("picker")).toBeNull();
    resize(310);
    expect(screen.queryByTestId("picker")).toBeNull();
  });

  it("remeasures tab additions and removals without a window resize", () => {
    setupGeometry();
    const { rerender } = render(<Harness />);
    tabsWidth = 450;
    rerender(<Harness tabs={2} />);
    expect(screen.getByTestId("picker")).toBeInTheDocument();
    tabsWidth = 300;
    rerender(<Harness />);
    expect(screen.queryByTestId("picker")).toBeNull();
  });

  it("scrolls overflowing tabs with a vertical wheel while preserving horizontal gestures", () => {
    setupGeometry();
    tabsWidth = 450;
    const { container } = render(<Harness />);
    const viewport = container.querySelector<HTMLElement>("[data-workspace-tabs-viewport]")!;
    fireEvent.wheel(viewport, { deltaY: 30 });
    expect(viewport.scrollLeft).toBe(30);
    fireEvent.wheel(viewport, { deltaX: 20 });
    expect(viewport.scrollLeft).toBe(30);
    resize(500);
    fireEvent.wheel(viewport, { deltaY: 30 });
    expect(viewport.scrollLeft).toBe(30);
  });

  it.each([
    { deltaMode: 0, deltaY: 2, expected: 2 },
    { deltaMode: 1, deltaY: -2, expected: -32 },
    { deltaMode: 2, deltaY: 1, expected: 272 },
    { deltaMode: 0, deltaX: 15, deltaY: 20, ctrlKey: true, expected: 15 },
  ])("normalizes wheel units for $deltaMode and $deltaY", ({ expected, ...wheel }) => {
    setupGeometry();
    tabsWidth = 450;
    const { container } = render(<Harness />);
    const viewport = container.querySelector<HTMLElement>("[data-workspace-tabs-viewport]")!;
    expect(fireEvent.wheel(viewport, wheel)).toBe(false);
    expect(viewport.scrollLeft).toBe(expected);
  });

  it("exposes the viewport ref, attributes and styles without replacing scroll handling", () => {
    setupGeometry();
    tabsWidth = 450;
    const viewportRef = { current: null as HTMLDivElement | null };
    const onScroll = vi.fn();
    render(
      <WorkspaceTabsScroller
        viewportRef={viewportRef}
        role="tablist"
        aria-label="Dock tabs"
        className="dock-tabs"
        contentClassName="dock-tabs-content"
        onScroll={onScroll}
      >
        <button type="button">Tab</button>
      </WorkspaceTabsScroller>,
    );
    const viewport = screen.getByRole("tablist", { name: "Dock tabs" });
    expect(viewportRef.current).toBe(viewport);
    expect(viewport).toHaveClass("dock-tabs");
    expect(viewport.querySelector("[data-workspace-tabs-content]")).toHaveClass(
      "dock-tabs-content",
    );
    fireEvent.wheel(viewport, { deltaY: 25 });
    expect(viewport.scrollLeft).toBe(25);
    fireEvent.scroll(viewport);
    expect(onScroll).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reveals the complete active tab on resize (grouped: %s)", (grouped) => {
    setupGeometry();
    render(
      <WorkspaceTabsScroller>
        <div data-workspace-tab={grouped || undefined}>
          <button type="button" aria-selected="true">
            Selected
          </button>
          <button type="button">Close</button>
        </div>
      </WorkspaceTabsScroller>,
    );
    const selected = screen.getByRole("button", { name: "Selected" });
    const target = grouped ? selected.parentElement! : selected;
    const reveal = vi.spyOn(target, "scrollIntoView");
    resize(250);
    expect(reveal).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it.each([1, 2, 12])("centers every fixed slot including endpoints for %s images", (count) => {
    setupGeometry();
    tabsWidth = count * 84 - 4;
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const viewport = this.closest<HTMLElement>("[data-workspace-tabs-viewport]");
      const index = Number(this.dataset.slot);
      const padding = Number.parseFloat(this.parentElement?.style.paddingInline || "0");
      return {
        left:
          this.dataset.slot === undefined ? 10 : 10 + padding + index * 84 - viewport!.scrollLeft,
        width: this.dataset.slot === undefined ? availableWidth : 80,
      } as DOMRect;
    });
    function Slots({ selected }: { selected: number }) {
      return (
        <WorkspaceTabsScroller activeAlignment="center" activeKey={selected}>
          {Array.from({ length: count }, (_, index) => (
            <button
              type="button"
              key={index}
              data-slot={index}
              aria-current={selected === index ? "true" : undefined}
            >
              {index}
            </button>
          ))}
        </WorkspaceTabsScroller>
      );
    }
    const { rerender, container } = render(<Slots selected={0} />);
    const installed = resizeObservers.length;
    const viewport = container.querySelector<HTMLElement>("[data-workspace-tabs-viewport]")!;
    for (const width of [300, 160, 44, 700]) {
      resize(width);
      for (let selected = 0; selected < count; selected++) {
        rerender(<Slots selected={selected} />);
        expect(resizeObservers).toHaveLength(installed);
        const slot = screen.getByRole("button", { name: String(selected) }).getBoundingClientRect();
        expect(slot.left + slot.width / 2).toBeCloseTo(10 + width / 2);
        expect(viewport.scrollLeft).toBeGreaterThanOrEqual(0);
        expect(viewport.scrollLeft).toBeLessThanOrEqual(
          Math.max(0, (count - 1) * 84 + Math.max(0, 80 - width)),
        );
      }
    }
    viewport.scrollLeft = 0;
    fireEvent.scroll(viewport);
    expect(viewport.scrollLeft).toBe(0);
    rerender(<Slots selected={count - 1} />);
    expect(viewport.scrollLeft).toBe(0);
  });

  it.each([200, 500])(
    "contains wheel events for a gallery of width %s, including nonoverflow",
    (width) => {
      setupGeometry();
      tabsWidth = width;
      const parentWheel = vi.fn();
      render(
        <div onWheel={parentWheel}>
          <WorkspaceTabsScroller containWheel role="group">
            <button type="button">Image</button>
          </WorkspaceTabsScroller>
        </div>,
      );
      const viewport = screen.getByRole("group");
      expect(fireEvent.wheel(viewport, { deltaY: 30 })).toBe(false);
      expect(viewport.scrollLeft).toBe(width > 300 ? 30 : 0);
      expect(parentWheel).not.toHaveBeenCalled();
      expect(viewport).toHaveStyle({ overscrollBehavior: "contain" });
      expect(fireEvent.wheel(viewport, { deltaX: 20 })).toBe(width > 300);
    },
  );
});
