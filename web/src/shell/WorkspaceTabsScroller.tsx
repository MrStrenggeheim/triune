// Modified for Triune.

import {
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useEffect,
  useRef,
} from "react";

/** Scroll open tabs horizontally with a hidden scrollbar. */
export function WorkspaceTabsScroller({
  children,
  onOverflowChange,
  overflowControlRef,
  grow = true,
  viewportRef: suppliedViewportRef,
  className,
  contentClassName,
  activeAlignment = "nearest",
  activeKey,
  containWheel = false,
  style,
  ...viewportProps
}: {
  children: ReactNode;
  grow?: boolean;
  onOverflowChange?: (overflow: boolean) => void;
  overflowControlRef?: RefObject<HTMLDivElement | null>;
  viewportRef?: RefObject<HTMLDivElement | null>;
  contentClassName?: string;
  activeAlignment?: "nearest" | "center";
  /** Align on selection/resize, preserving manual scrolling between changes. */
  activeKey?: string | number;
  containWheel?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  const localViewportRef = useRef<HTMLDivElement>(null);
  const viewportRef = suppliedViewportRef ?? localViewportRef;
  const contentRef = useRef<HTMLDivElement>(null);

  const measureOverflow = useCallback(() => {
    if (!onOverflowChange) return;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    // Compare against the space available with the picker removed, even while
    // it is mounted. Reserving it before this comparison would make it sticky.
    const available = viewport.clientWidth + (overflowControlRef?.current?.offsetWidth ?? 0);
    onOverflowChange(content.scrollWidth > available);
  }, [onOverflowChange, overflowControlRef, viewportRef]);

  useLayoutEffect(measureOverflow, [children, measureOverflow]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!onOverflowChange || !viewport || !content) return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(viewport);
    observer.observe(content);
    window.addEventListener("resize", measureOverflow);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [measureOverflow, onOverflowChange, viewportRef]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const wheel = (event: WheelEvent) => {
      const overflowing = viewport.scrollWidth > viewport.clientWidth;
      if (containWheel) {
        event.stopPropagation();
        if (!overflowing) event.preventDefault();
      }
      if (!overflowing) return;
      // Leave native horizontal gestures alone. Ctrl-wheel must be non-passive
      // to scroll tabs instead of zooming the page.
      if (event.deltaX && !event.ctrlKey) return;
      const delta = event.deltaX || event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
      viewport.scrollLeft += delta * unit;
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [containWheel, viewportRef]);

  const align = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const active = content.querySelector<HTMLElement>(
      '[aria-current="true"], [aria-selected="true"]',
    );
    // A grouped tab includes its close control in the visible scroll target.
    const target = active?.closest<HTMLElement>("[data-workspace-tab]") ?? active;
    if (!target) return;
    if (activeAlignment === "center") {
      // Equal endpoint space lets even the first/last fixed slot reach center.
      content.style.paddingInline = `${Math.max(0, (viewport.clientWidth - target.offsetWidth) / 2)}px`;
      const slot = target.getBoundingClientRect();
      const frame = viewport.getBoundingClientRect();
      viewport.scrollLeft +=
        slot.left + slot.width / 2 - (frame.left + viewport.clientLeft + viewport.clientWidth / 2);
    } else {
      content.style.paddingInline = "";
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeAlignment, viewportRef]);

  useLayoutEffect(() => {
    if (activeAlignment === "center" || activeKey !== undefined) align();
  }, [activeAlignment, activeKey, align]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(align);
    observer.observe(viewport);
    observer.observe(content);
    window.addEventListener("resize", align);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", align);
    };
  }, [align, viewportRef]);

  return (
    <div
      {...viewportProps}
      ref={viewportRef}
      data-workspace-tabs-viewport
      style={{ ...(containWheel ? { overscrollBehavior: "contain" } : {}), ...style }}
      className={`no-drag min-w-0 ${grow ? "flex-1" : "flex-[0_1_auto]"} overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className ?? ""}`}
    >
      <div
        ref={contentRef}
        data-workspace-tabs-content
        className={`flex w-max items-center gap-0.5 ${activeAlignment === "center" ? "transition-none" : ""} ${contentClassName ?? ""}`}
      >
        {children}
      </div>
    </div>
  );
}
