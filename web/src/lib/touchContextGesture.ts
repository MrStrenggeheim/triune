// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { TouchSensor, type SensorProps, type TouchSensorOptions } from "@dnd-kit/core";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

export const TOUCH_MENU_DELAY = 500;
export const TOUCH_DRAG_DELAY = 300;
export const TOUCH_SLOP = 10;
export const TOUCH_DRAG_START_EVENT = "triune:touch-drag-start";

interface Point {
  x: number;
  y: number;
}
interface GestureOptions {
  onMenu: (point: Point) => void;
  onDragStart?: (point: Point) => void;
  onDragMove?: (point: Point) => void;
  onFinish?: (dragged: boolean, cancelled: boolean) => void;
}

/** One deadline and displacement measured from touch-down, shared by menus and tab dragging. */
export function createTouchContextGesture(origin: Point, options: GestureOptions) {
  const started = Date.now();
  let phase: "pending" | "menu" | "drag" | "scroll" | "finished" = "pending";
  let consumed = false;
  const timer = setTimeout(() => {
    if (phase !== "pending") return;
    phase = "menu";
    consumed = true;
    options.onMenu(origin);
  }, TOUCH_MENU_DELAY);
  return {
    get consumed() {
      return consumed;
    },
    get dragging() {
      return phase === "drag";
    },
    move(point: Point) {
      if (phase === "finished" || phase === "scroll") return false;
      if (phase !== "drag" && Math.hypot(point.x - origin.x, point.y - origin.y) >= TOUCH_SLOP) {
        clearTimeout(timer);
        if (options.onDragStart && Date.now() - started >= TOUCH_DRAG_DELAY) {
          phase = "drag";
          consumed = true;
          options.onDragStart(origin);
        } else {
          phase = "scroll";
        }
      }
      if (phase === "drag") options.onDragMove?.(point);
      return consumed;
    },
    finish(cancelled = false) {
      if (phase === "finished") return;
      clearTimeout(timer);
      const dragged = phase === "drag";
      phase = "finished";
      options.onFinish?.(dragged, cancelled);
    },
  };
}

const heldMenus = new WeakSet<Event>();
const multipleContacts = new WeakSet<Event>();
export function openTouchContextMenu(element: HTMLElement, point: Point) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
  });
  heldMenus.add(event);
  element.dispatchEvent(event);
}

function editable(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
  );
}

/** Native touchmove listeners retain scrolling until a held contact actually starts dragging. */
export function trackTouchContextGesture(
  element: HTMLElement,
  start: PointerEvent | TouchEvent,
  options: GestureOptions & { allowEditable?: boolean },
) {
  const doc = element.ownerDocument;
  const touch = "touches" in start ? start.touches[0] : undefined;
  if (
    multipleContacts.has(start) ||
    (!options.allowEditable && editable(start.target)) ||
    doc.getSelection()?.isCollapsed === false ||
    ("touches" in start && start.touches.length !== 1)
  ) {
    options.onFinish?.(false, true);
    return () => {};
  }
  const pointerId = "pointerId" in start ? start.pointerId : undefined;
  const origin = touch
    ? { x: touch.clientX, y: touch.clientY }
    : { x: (start as PointerEvent).clientX, y: (start as PointerEvent).clientY };
  const removers: (() => void)[] = [];
  const listen = (
    type: string,
    listener: EventListener,
    target: EventTarget = doc,
    capture = true,
  ) => {
    target.addEventListener(type, listener, { capture, passive: false });
    removers.push(() => target.removeEventListener(type, listener, capture));
  };
  const gesture = createTouchContextGesture(origin, {
    ...options,
    onMenu: (point) => {
      if (!element.isConnected || doc.getSelection()?.isCollapsed === false) return finish(true);
      options.onMenu(point);
    },
  });
  const suppress = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  let finished = false;
  function finish(cancelled = false) {
    if (finished) return;
    finished = true;
    removers.forEach((remove) => remove());
    if (gesture.consumed) {
      // Discard the release click, but let a subsequent deliberate contact act immediately.
      const clear = () => {
        clearTimeout(expiry);
        doc.removeEventListener("click", click, true);
        doc.removeEventListener("pointerup", release, true);
        doc.removeEventListener("touchend", release, true);
        doc.removeEventListener("pointerdown", clear, true);
        doc.removeEventListener("touchstart", clear, true);
        doc.removeEventListener("keydown", clear, true);
      };
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const release = (event: Event) => {
        suppress(event);
        clearTimeout(expiry);
        expiry = setTimeout(clear, 800);
      };
      const click = (event: Event) => {
        suppress(event);
        clear();
      };
      if (!cancelled) expiry = setTimeout(clear, 800);
      doc.addEventListener("click", click, true);
      doc.addEventListener("pointerup", release, true);
      doc.addEventListener("touchend", release, true);
      doc.addEventListener("pointerdown", clear, true);
      doc.addEventListener("touchstart", clear, true);
      doc.addEventListener("keydown", clear, true);
    }
    gesture.finish(cancelled);
  }
  listen(touch ? "touchmove" : "pointermove", (event) => {
    let point: Point;
    if ("touches" in event) {
      const current = (event as TouchEvent).touches;
      if (current.length !== 1 || current[0].identifier !== touch?.identifier) return finish(true);
      point = { x: current[0].clientX, y: current[0].clientY };
    } else {
      const current = event as PointerEvent;
      if (current.pointerId !== pointerId) return;
      point = { x: current.clientX, y: current.clientY };
    }
    if (gesture.move(point) && event.cancelable) event.preventDefault();
  });
  listen(touch ? "touchend" : "pointerup", (event) => {
    if (!touch && (event as PointerEvent).pointerId !== pointerId) return;
    if (gesture.consumed) suppress(event);
    finish();
  });
  if (touch)
    listen("pointerup", (event) => {
      if (gesture.consumed) suppress(event);
    });
  listen("pointercancel", () => {
    // A native touch drag can outlive Chromium's cancelled pointer stream.
    if (!touch || !gesture.dragging) finish(true);
  });
  listen("touchcancel", () => finish(true));
  listen("touchstart", (event) => {
    if ((event as TouchEvent).touches.length > 1) finish(true);
  });
  listen("pointerdown", (event) => {
    if (!touch && (event as PointerEvent).pointerId !== pointerId) {
      multipleContacts.add(event);
      finish(true);
    }
  });
  listen("contextmenu", (event) => {
    if (!heldMenus.has(event) && event.target instanceof Node && element.contains(event.target))
      suppress(event);
  });
  listen("scroll", (event) => {
    if (
      !gesture.dragging &&
      (event.target === doc || (event.target instanceof Element && event.target.contains(element)))
    )
      finish(true);
  });
  listen("selectionchange", () => {
    if (doc.getSelection()?.isCollapsed === false) finish(true);
  });
  listen("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") finish(true);
  });
  listen("visibilitychange", () => {
    if (doc.hidden) finish(true);
  });
  if (doc.defaultView) {
    listen(
      "blur",
      (event) => {
        if (event.target === event.currentTarget) finish(true);
      },
      doc.defaultView,
    );
    listen("resize", () => finish(true), doc.defaultView);
  }
  return () => finish(true);
}

/** Custom contextmenu handlers can share hold behavior without wrapping or changing their menus. */
export function useTouchContextMenu(disabled = false) {
  const cancel = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancel.current?.(), []);
  return (event: ReactPointerEvent<HTMLElement>) => {
    if (disabled || event.defaultPrevented || event.pointerType !== "touch") return;
    // Only the nearest menu target owns a bubbling touch-down.
    if (
      event.target instanceof Element &&
      event.target.closest("[data-touch-context-menu]") !== event.currentTarget
    )
      return;
    cancel.current?.();
    const element = event.currentTarget;
    cancel.current = trackTouchContextGesture(element, event.nativeEvent, {
      onMenu: (point) => openTouchContextMenu(element, point),
    });
  };
}

/** Reuse dnd-kit's placement and previews after the shared hold/movement arbitration. */
export class TouchContextSensor {
  static activators = TouchSensor.activators;
  static sessions = new Map<() => void, HTMLElement>();
  static setup() {
    const teardown = TouchSensor.setup();
    return () => {
      teardown?.();
      TouchContextSensor.sessions.forEach((element, cancel) => {
        if (!element.isConnected) cancel();
      });
    };
  }
  autoScrollEnabled = true;
  constructor(props: SensorProps<TouchSensorOptions>) {
    const node = props.activeNode.node.current;
    const target = props.event.target;
    const menuTarget =
      target instanceof Element ? target.closest<HTMLElement>("[data-touch-context-menu]") : null;
    const element = menuTarget && node?.contains(menuTarget) ? menuTarget : node;
    if (!element) {
      props.onCancel();
      return;
    }
    let cancel: (() => void) | undefined;
    let finished = false;
    cancel = trackTouchContextGesture(element, props.event as TouchEvent, {
      onMenu: (point) => openTouchContextMenu(element, point),
      onDragStart: (point) => {
        element.dispatchEvent(new Event(TOUCH_DRAG_START_EVENT, { bubbles: true }));
        props.onStart(point);
      },
      onDragMove: props.onMove,
      onFinish: (dragged, cancelled) => {
        finished = true;
        if (cancel) TouchContextSensor.sessions.delete(cancel);
        if (!dragged) props.onAbort(props.active);
        if (dragged && !cancelled) props.onEnd();
        else props.onCancel();
      },
    });
    if (!finished) TouchContextSensor.sessions.set(cancel, element);
  }
}
