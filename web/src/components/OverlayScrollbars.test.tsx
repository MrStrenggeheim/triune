// Modified for Triune.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayScrollbars } from "./OverlayScrollbars";

let resizeCallbacks: ResizeObserverCallback[];
let metrics: {
  clientHeight: number;
  scrollHeight: number;
  clientWidth: number;
  scrollWidth: number;
};

beforeEach(() => {
  vi.useFakeTimers();
  metrics = { clientHeight: 200, scrollHeight: 800, clientWidth: 300, scrollWidth: 300 };
  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const property of ["clientHeight", "scrollHeight", "clientWidth", "scrollWidth"] as const) {
    vi.spyOn(HTMLElement.prototype, property, "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-test-surface") ? metrics[property] : 0;
    });
  }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-test-surface")
      ? new DOMRect(20, 30, metrics.clientWidth, metrics.clientHeight)
      : new DOMRect();
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32);
  });
}

function renderSurface(attributes = {}) {
  const view = render(
    <>
      <OverlayScrollbars />
      <section>
        <div data-test-surface style={{ overflowY: "auto", overflowX: "auto" }} {...attributes}>
          <p>Content</p>
        </div>
      </section>
    </>,
  );
  const element = view.container.querySelector<HTMLElement>("[data-test-surface]")!;
  const thumb = (axis = "vertical") =>
    view.container.querySelector<HTMLElement>(`[data-overlay-scrollbar-thumb="${axis}"]`)!;
  return { ...view, element, thumb };
}

describe("OverlayScrollbars", () => {
  it("bounds discovery work while resizing a retained subtree", async () => {
    const { element } = renderSurface();
    const retained = element.parentElement!;
    for (let index = 0; index < 240; index++) retained.append(document.createElement("span"));
    await flush();
    const styles = vi.spyOn(window, "getComputedStyle");
    retained.style.width = "600px";
    await flush();
    const descendants = styles.mock.calls.filter(
      ([node]) => node !== retained && retained.contains(node),
    );
    process.stdout.write(
      `overlay resize discovery descendant style reads: ${descendants.length}\n`,
    );
    expect(descendants).toHaveLength(1);
  });

  it("uses the original scroll node, adds no wrappers and restores native styling on unmount", () => {
    const { container, element, thumb, unmount } = renderSurface();
    expect(element.parentElement?.tagName).toBe("SECTION");
    expect(element.children).toHaveLength(1);
    expect(element).toHaveAttribute("data-overlay-scroll-surface");
    expect(thumb()).toHaveStyle({ height: "56px", display: "block" });
    expect(thumb("horizontal")).toHaveStyle({ display: "none" });
    expect(container.querySelector("[data-overlay-scrollbar]")).toHaveStyle({
      left: "20px",
      top: "30px",
      width: "300px",
      height: "200px",
    });
    unmount();
    expect(element).not.toHaveAttribute("data-overlay-scroll-surface");
  });

  it("hides both thumbs when content fits and reacts to content growth/shrinkage", async () => {
    metrics.scrollHeight = metrics.clientHeight;
    const { element, thumb } = renderSurface();
    expect(thumb()).toHaveStyle({ display: "none" });
    metrics.scrollHeight = 800;
    await act(async () => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });
    await flush();
    expect(thumb()).toHaveStyle({ display: "block" });
    metrics.scrollHeight = 200;
    element.firstElementChild!.textContent = "Short content";
    await flush();
    expect(thumb()).toHaveStyle({ display: "none" });
  });

  it.each(["vertical", "horizontal"] as const)(
    "drags %s without consuming wheel or keyboard input",
    (axis) => {
      metrics.scrollWidth = 900;
      const { element, thumb } = renderSurface();
      const control = thumb(axis);
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 30 });
      const keyboard = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
      });
      element.dispatchEvent(wheel);
      element.dispatchEvent(keyboard);
      expect(wheel.defaultPrevented).toBe(false);
      expect(keyboard.defaultPrevented).toBe(false);
      fireEvent.pointerDown(control, { button: 2, pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(control, { pointerId: 1, clientX: 120, clientY: 120 });
      expect(element.scrollTop).toBe(0);
      expect(element.scrollLeft).toBe(0);
      fireEvent.pointerDown(control, {
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        pointerType: "touch",
      });
      fireEvent.pointerMove(control, {
        pointerId: 1,
        clientX: 120,
        clientY: 120,
        pointerType: "touch",
      });
      expect(axis === "vertical" ? element.scrollTop : element.scrollLeft).toBeGreaterThan(0);
      fireEvent.pointerCancel(control, { pointerId: 1 });
      const position = axis === "vertical" ? element.scrollTop : element.scrollLeft;
      fireEvent.pointerMove(control, { pointerId: 1, clientX: 150, clientY: 150 });
      expect(axis === "vertical" ? element.scrollTop : element.scrollLeft).toBe(position);
    },
  );

  it.each([
    { "data-composer-card": "" },
    { className: "chat-composer-form" },
    { className: "composer-input-text" },
    { role: "tablist" },
    { className: "monaco-editor" },
    { className: "monaco-diff-editor" },
    { className: "xterm" },
    { className: "transcript-hide-native-scrollbar" },
    { "data-slot": "scroll-area" },
    { "data-scrollbar": "native" },
    { "data-scrollbar": "hidden" },
  ])("leaves specialized surface %j alone, including descendants", (attributes) => {
    const { container, element } = renderSurface(attributes);
    expect(element).not.toHaveAttribute("data-overlay-scroll-surface");
    expect(container.querySelector("[data-overlay-scrollbar]")).toBeNull();
  });

  it("discovers new portal surfaces and removes layers for disconnected surfaces", async () => {
    render(<OverlayScrollbars />);
    const portal = document.createElement("section");
    portal.innerHTML =
      '<div data-test-surface style="overflow-y: auto; overflow-x: auto"><p>Menu</p></div>';
    document.body.append(portal);
    await flush();
    const element = portal.firstElementChild!;
    expect(element).toHaveAttribute("data-overlay-scroll-surface");
    expect(portal.querySelector("[data-overlay-scrollbar]")).not.toBeNull();
    portal.remove();
    await flush();
    expect(element).not.toHaveAttribute("data-overlay-scroll-surface");
    expect(portal.querySelector("[data-overlay-scrollbar]")).toBeNull();
  });
});
