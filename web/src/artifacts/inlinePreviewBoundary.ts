// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/** Visible view height, independent of where a particular message sits in its transcript. */
export function inlinePreviewHeight(
  view: { top: number; bottom: number },
  viewportTop: number,
  viewportHeight: number,
) {
  return (
    Math.max(
      0,
      Math.min(view.bottom, viewportTop + viewportHeight) - Math.max(view.top, viewportTop),
    ) * 0.6
  );
}

const VIEWPORT_CAP =
  "calc((var(--omnigent-viewport-height, 100dvh) - var(--omnigent-safe-top, 0px) - var(--omnigent-safe-bottom, 0px)) * 0.6)";

/** Observe the owning view rather than the preview's growing content; never move its scroll. */
export function useInlinePreviewBoundary(
  ref: RefObject<HTMLElement | null>,
  inline: boolean,
): CSSProperties | undefined {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const node = ref.current;
    if (!inline || !node) return;
    const view = node.closest<HTMLElement>(
      "[data-chat-surface], .side-chat-backdrop, [data-workbench-view], [data-resource-view]",
    );
    const viewport = window.visualViewport;
    const measure = () => {
      const top = viewport?.offsetTop ?? 0;
      const visibleHeight = viewport?.height ?? window.innerHeight;
      const bounds = view?.getBoundingClientRect() ?? { top, bottom: top + visibleHeight };
      const next = inlinePreviewHeight(bounds, top, visibleHeight);
      // Retained hidden views have no geometry; keep their last usable boundary.
      if (next > 0) setHeight(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (view) observer.observe(view);
    window.addEventListener("resize", measure);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
    };
  }, [ref, inline]);
  return inline
    ? { maxHeight: height ? `min(${height}px, ${VIEWPORT_CAP})` : VIEWPORT_CAP }
    : undefined;
}
