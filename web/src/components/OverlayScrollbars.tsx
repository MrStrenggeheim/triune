// Modified for Triune.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ScrollbarThumb, scrollbarGeometry } from "@/components/ui/overlay-scrollbar";
import { getEmbedRoot } from "@/lib/host";

const EXCLUDED = [
  ".monaco-editor",
  ".monaco-diff-editor",
  ".xterm",
  ".transcript-hide-native-scrollbar",
  "[data-transcript-scrollbar]",
  "[data-slot='scroll-area']",
  "[data-overlay-scrollbar]",
  "[data-composer-card]",
  ".chat-composer-form",
  ".composer-input-text",
  "[role='tablist']",
  "[data-scrollbar='hidden']",
  "[data-scrollbar='native']",
].join(",");

function isScrollSurface(element: HTMLElement) {
  if (element.closest(EXCLUDED)) return false;
  const style = getComputedStyle(element);
  return (
    /^(auto|scroll)$/.test(style.overflowY || style.overflow) ||
    /^(auto|scroll)$/.test(style.overflowX || style.overflow)
  );
}

const GEOMETRY_STYLES = new Set([
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "left",
  "right",
  "top",
  "bottom",
  "flex-basis",
  "transform",
]);

function onlyGeometryChanged(element: HTMLElement, oldStyle: string | null) {
  const previous = document.createElement("div").style;
  previous.cssText = oldStyle ?? "";
  const properties = new Set([...Array.from(previous), ...Array.from(element.style)]);
  for (const property of properties) {
    if (
      previous.getPropertyValue(property) === element.style.getPropertyValue(property) &&
      previous.getPropertyPriority(property) === element.style.getPropertyPriority(property)
    )
      continue;
    if (!GEOMETRY_STYLES.has(property)) return false;
  }
  // A container's dimensions can change descendant overflow rules via @container.
  const containerType = getComputedStyle(element).containerType;
  return !containerType || containerType === "normal";
}

/**
 * Mount <OverlayScrollbars /> once inside WorkbenchShell, beside its content.
 * Discovers native overflow surfaces and portaled menus/dialogs in the theme root.
 * No wrappers or wheel/keyboard interception; data-scrollbar="native" opts out.
 */
export function OverlayScrollbars() {
  const [surfaces, setSurfaces] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => {
    const root = getEmbedRoot() ?? document.body;
    const candidates = new Set<HTMLElement>();
    const dirty = new Set<HTMLElement>([root]);
    const dirtyElements = new Set<HTMLElement>();
    let frame = 0;
    const discover = () => {
      frame = 0;
      for (const subtree of dirty) {
        if (!root.contains(subtree)) continue;
        if (subtree.closest(EXCLUDED)) continue;
        let covered = false;
        for (let ancestor = subtree.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (dirty.has(ancestor)) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
        for (const element of [subtree, ...subtree.querySelectorAll<HTMLElement>("*")]) {
          if (element instanceof HTMLElement && isScrollSurface(element)) candidates.add(element);
        }
      }
      dirty.clear();
      for (const element of dirtyElements) {
        if (root.contains(element) && isScrollSurface(element)) candidates.add(element);
      }
      dirtyElements.clear();
      for (const element of candidates) {
        if (!root.contains(element) || !isScrollSurface(element)) candidates.delete(element);
      }
      setSurfaces((previous) => {
        const next = [...candidates];
        return next.length === previous.length &&
          next.every((element, index) => element === previous[index])
          ? previous
          : next;
      });
    };
    discover();
    const observer = new MutationObserver((records) => {
      let changed = false;
      for (const record of records) {
        if (
          !(record.target instanceof HTMLElement) ||
          record.target.closest("[data-overlay-scrollbar]")
        )
          continue;
        if (record.type === "attributes") {
          if (
            record.attributeName === "style" &&
            onlyGeometryChanged(record.target, record.oldValue)
          )
            dirtyElements.add(record.target);
          else dirty.add(record.target);
          changed = true;
        } else {
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (node instanceof HTMLElement && !node.matches("[data-overlay-scrollbar]")) {
              changed = true;
              if (node.isConnected) dirty.add(node);
            }
          }
        }
      }
      if (changed && !frame) frame = requestAnimationFrame(discover);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["class", "style", "hidden", "data-state", "data-scrollbar"],
    });
    const rediscover = () => {
      dirty.add(root);
      if (!frame) frame = requestAnimationFrame(discover);
    };
    window.addEventListener("resize", rediscover);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", rediscover);
    };
  }, []);
  return (
    <>
      {surfaces.map((element) => (
        <SurfaceScrollbar key={surfaceId(element)} element={element} />
      ))}
    </>
  );
}

const surfaceIds = new WeakMap<HTMLElement, number>();
let nextSurfaceId = 0;
function surfaceId(element: HTMLElement) {
  if (!surfaceIds.has(element)) surfaceIds.set(element, ++nextSurfaceId);
  return surfaceIds.get(element)!;
}

function SurfaceScrollbar({ element }: { element: HTMLElement }) {
  const layer = useRef<HTMLDivElement>(null);
  const vertical = useRef<HTMLDivElement>(null);
  const horizontal = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    axis: "vertical" | "horizontal";
    last: number;
    pointerId: number;
    thumb: HTMLDivElement;
  } | null>(null);
  const [dragging, setDragging] = useState<"vertical" | "horizontal" | null>(null);

  useLayoutEffect(() => {
    const previous = element.getAttribute("data-overlay-scroll-surface");
    element.setAttribute("data-overlay-scroll-surface", "");
    let frame = 0;
    const endDrag = () => {
      const current = drag.current;
      if (current?.thumb.hasPointerCapture(current.pointerId))
        current.thumb.releasePointerCapture(current.pointerId);
      drag.current = null;
      setDragging(null);
    };
    const measure = () => {
      frame = 0;
      const overlay = layer.current;
      if (!overlay) return;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        !element.closest("[hidden], [inert], [aria-hidden='true']");
      overlay.style.display = visible ? "block" : "none";
      if (!visible) {
        endDrag();
        return;
      }
      // Fixed portals stay in the surface's stacking context, including transformed dialogs.
      const origin = overlay.getBoundingClientRect();
      const scaleX = origin.width / overlay.offsetWidth || 1;
      const scaleY = origin.height / overlay.offsetHeight || 1;
      overlay.style.left = `${(parseFloat(overlay.style.left) || 0) + (rect.left - origin.left) / scaleX}px`;
      overlay.style.top = `${(parseFloat(overlay.style.top) || 0) + (rect.top - origin.top) / scaleY}px`;
      overlay.style.width = `${rect.width / scaleX}px`;
      overlay.style.height = `${rect.height / scaleY}px`;
      overlay.style.zIndex = String((parseInt(style.zIndex) || 0) + 1);
      let top = Math.max(0, rect.top),
        left = Math.max(0, rect.left);
      let bottom = Math.min(window.innerHeight, rect.bottom),
        right = Math.min(window.innerWidth, rect.right);
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        const bounds = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowY || ancestorStyle.overflow)) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowX || ancestorStyle.overflow)) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
      }
      overlay.style.clipPath = `inset(${Math.max(0, top - rect.top) / scaleY}px ${Math.max(0, rect.right - right) / scaleX}px ${Math.max(0, rect.bottom - bottom) / scaleY}px ${Math.max(0, left - rect.left) / scaleX}px)`;
      for (const axis of ["vertical", "horizontal"] as const) {
        const thumb = axis === "vertical" ? vertical.current : horizontal.current;
        if (!thumb) continue;
        const viewport = axis === "vertical" ? element.clientHeight : element.clientWidth;
        const content = axis === "vertical" ? element.scrollHeight : element.scrollWidth;
        const track = viewport - 8;
        const geometry = scrollbarGeometry(viewport, content, track, Math.min(56, track / 2));
        const overflow = axis === "vertical" ? style.overflowY : style.overflowX;
        const shown =
          /^(auto|scroll)$/.test(overflow || style.overflow) &&
          geometry.range > 1 &&
          geometry.thumb > 0 &&
          geometry.travel > 0;
        thumb.style.display = shown ? "block" : "none";
        if (!shown && drag.current?.axis === axis) endDrag();
        const position = axis === "vertical" ? element.scrollTop : Math.abs(element.scrollLeft);
        const offset = geometry.range
          ? Math.max(0, Math.min(1, position / geometry.range)) * geometry.travel
          : 0;
        const translated =
          axis === "horizontal" && style.direction === "rtl" ? geometry.travel - offset : offset;
        thumb.style[axis === "vertical" ? "height" : "width"] = `${geometry.thumb}px`;
        thumb.style.transform =
          axis === "vertical" ? `translateY(${translated}px)` : `translateX(${translated}px)`;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const observedChildren = new Set<Element>();
    const observeChildren = () => {
      for (const child of observedChildren) {
        if (child.parentElement !== element) {
          resize.unobserve(child);
          observedChildren.delete(child);
        }
      }
      for (const child of element.children) {
        if (!child.matches("[data-overlay-scrollbar]") && !observedChildren.has(child)) {
          resize.observe(child);
          observedChildren.add(child);
        }
      }
    };
    observeChildren();
    const mutation = new MutationObserver((records) => {
      if (
        records.every(
          (record) =>
            record.target instanceof Element && record.target.closest("[data-overlay-scrollbar]"),
        )
      )
        return;
      observeChildren();
      schedule();
    });
    mutation.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
    });
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      endDrag();
      resize.disconnect();
      mutation.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (previous === null) element.removeAttribute("data-overlay-scroll-surface");
      else element.setAttribute("data-overlay-scroll-surface", previous);
    };
  }, [element]);

  const endDrag = () => {
    const current = drag.current;
    if (current?.thumb.hasPointerCapture(current.pointerId))
      current.thumb.releasePointerCapture(current.pointerId);
    drag.current = null;
    setDragging(null);
  };
  const thumb = (axis: "vertical" | "horizontal") => (
    <ScrollbarThumb
      ref={axis === "vertical" ? vertical : horizontal}
      orientation={axis}
      dragging={dragging === axis}
      data-overlay-scrollbar-thumb={axis}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          axis,
          last: axis === "vertical" ? event.clientY : event.clientX,
          pointerId: event.pointerId,
          thumb: event.currentTarget,
        };
        setDragging(axis);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId || current.axis !== axis) return;
        const viewport = axis === "vertical" ? element.clientHeight : element.clientWidth;
        const content = axis === "vertical" ? element.scrollHeight : element.scrollWidth;
        const { travel, range } = scrollbarGeometry(
          viewport,
          content,
          viewport - 8,
          Math.min(56, (viewport - 8) / 2),
        );
        if (travel <= 0) return;
        const next = axis === "vertical" ? event.clientY : event.clientX;
        const distance = ((next - current.last) / travel) * range;
        current.last = next;
        if (axis === "vertical") element.scrollTop += distance;
        else element.scrollLeft += distance;
        // Programmatic scroll events are asynchronous; keep the drag visibly in step.
        element.dispatchEvent(new Event("scroll"));
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    />
  );
  if (!element.parentElement) return null;
  return createPortal(
    <div
      ref={layer}
      aria-hidden
      data-overlay-scrollbar=""
      className="pointer-events-none fixed"
      style={{ left: 0, top: 0, width: 1, height: 1 }}
    >
      <div className="absolute top-1 right-1 bottom-1 w-3">{thumb("vertical")}</div>
      <div className="absolute right-1 bottom-1 left-1 h-3">{thumb("horizontal")}</div>
    </div>,
    element.parentElement,
  );
}
