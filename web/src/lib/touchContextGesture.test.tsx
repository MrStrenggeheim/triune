// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createTouchContextGesture, trackTouchContextGesture } from "./touchContextGesture";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});
const origin = { x: 20, y: 20 };
function controller() {
  const actions = { onMenu: vi.fn(), onDragStart: vi.fn(), onDragMove: vi.fn(), onFinish: vi.fn() };
  return { gesture: createTouchContextGesture(origin, actions), ...actions };
}

describe("touch arbitration", () => {
  it("keeps a quick tap and sub-slop jitter available to the browser", () => {
    const state = controller();
    for (const x of [25, 15, 26, 14, 20]) expect(state.gesture.move({ x, y: 20 })).toBe(false);
    vi.advanceTimersByTime(499);
    state.gesture.finish();
    vi.advanceTimersByTime(1000);
    expect(state.onMenu).not.toHaveBeenCalled();
    expect(state.onDragStart).not.toHaveBeenCalled();
    expect(state.onFinish).toHaveBeenCalledExactlyOnceWith(false, false);
  });

  it("gives early movement permanent scroll ownership, even after returning to the origin", () => {
    const state = controller();
    vi.advanceTimersByTime(299);
    expect(state.gesture.move({ x: 30, y: 20 })).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(state.gesture.move(origin)).toBe(false);
    expect(state.onMenu).not.toHaveBeenCalled();
    expect(state.onDragStart).not.toHaveBeenCalled();
    state.gesture.finish();
  });

  it("arms at 300ms without dragging until displacement reaches 10px", () => {
    const state = controller();
    vi.advanceTimersByTime(300);
    expect(state.gesture.move({ x: 29.9, y: 20 })).toBe(false);
    expect(state.onDragStart).not.toHaveBeenCalled();
    expect(state.gesture.move({ x: 30, y: 20 })).toBe(true);
    expect(state.onDragStart).toHaveBeenCalledExactlyOnceWith(origin);
    expect(state.onDragMove).toHaveBeenCalledWith({ x: 30, y: 20 });
    vi.advanceTimersByTime(1000);
    expect(state.onMenu).not.toHaveBeenCalled();
    state.gesture.finish();
    expect(state.onFinish).toHaveBeenCalledExactlyOnceWith(true, false);
  });

  it("opens at 500ms and can continue the same contact into dragging", () => {
    const state = controller();
    vi.advanceTimersByTime(499);
    expect(state.onMenu).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(state.onMenu).toHaveBeenCalledExactlyOnceWith(origin);
    expect(state.onDragStart).not.toHaveBeenCalled();
    state.gesture.move({ x: 26, y: 28 });
    expect(state.onDragStart).toHaveBeenCalledExactlyOnceWith(origin);
    state.gesture.finish(true);
    state.gesture.finish();
    expect(state.onFinish).toHaveBeenCalledExactlyOnceWith(true, true);
  });
});

function menus(onSelect = vi.fn(), onClick = vi.fn()) {
  const rendered = render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button" onClick={onClick}>
          File
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect}>Open file</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
  const target = screen.getByRole("button", { name: "File" });
  return { ...rendered, target, onClick, onSelect };
}
const pointer = { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 20 };

describe("shared context menu touch lifecycle", () => {
  it("opens through harmless jitter and blocks release on the menu and the trailing click", () => {
    const { target, onClick, onSelect } = menus();
    fireEvent.pointerDown(target, pointer);
    fireEvent.pointerMove(target, { ...pointer, clientX: 24 });
    act(() => vi.advanceTimersByTime(500));
    const item = screen.getByRole("menuitem", { name: "Open file" });
    expect(fireEvent.pointerUp(item, pointer)).toBe(false);
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.pointerDown(item, { ...pointer, pointerId: 2 });
    fireEvent.pointerUp(item, { ...pointer, pointerId: 2 });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it.each(["pointercancel", "scroll", "multitouch", "selection", "unmount"])(
    "cancels on %s",
    (reason) => {
      const { target, unmount } = menus();
      fireEvent.pointerDown(target, pointer);
      if (reason === "pointercancel") fireEvent.pointerCancel(target, pointer);
      if (reason === "scroll") fireEvent.scroll(document);
      if (reason === "multitouch") fireEvent.pointerDown(target, { ...pointer, pointerId: 2 });
      if (reason === "selection") {
        const range = document.createRange();
        range.selectNodeContents(target);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
        expect(document.getSelection()!.isCollapsed).toBe(false);
        fireEvent(document, new Event("selectionchange"));
        document.getSelection()!.removeAllRanges();
      }
      if (reason === "unmount") unmount();
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );

  it("does not interfere with text editing or normal tap activation", () => {
    const { target, onClick } = menus();
    fireEvent.pointerDown(target, pointer);
    fireEvent.pointerUp(target, pointer);
    fireEvent.click(target);
    expect(onClick).toHaveBeenCalledTimes(1);
    const input = document.createElement("input");
    target.append(input);
    fireEvent.pointerDown(input, pointer);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps right-click and keyboard menu activation intact", () => {
    const { target } = menus();
    fireEvent.contextMenu(target, { clientX: 30, clientY: 40 });
    expect(screen.getByRole("menuitem", { name: "Open file" })).toBeVisible();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(target, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Open file" })).toBeVisible();
  });

  it("suppresses a cancelled multi-touch release and still accepts a deliberate keyboard action", () => {
    const { target, onSelect } = menus();
    fireEvent.pointerDown(target, pointer);
    act(() => vi.advanceTimersByTime(500));
    const item = screen.getByRole("menuitem", { name: "Open file" });
    fireEvent.pointerDown(item, { ...pointer, pointerId: 2 });
    expect(fireEvent.pointerUp(item, pointer)).toBe(false);
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(item, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("cancels a native touch drag without ending it or retaining listeners", () => {
    const element = document.createElement("button");
    document.body.append(element);
    const touch = { identifier: 4, target: element, clientX: 20, clientY: 20 };
    const onFinish = vi.fn();
    const onDragStart = vi.fn();
    trackTouchContextGesture(
      element,
      { target: element, touches: [touch] } as unknown as TouchEvent,
      {
        onMenu: vi.fn(),
        onDragStart,
        onFinish,
      },
    );
    vi.advanceTimersByTime(300);
    expect(fireEvent.touchMove(element, { touches: [{ ...touch, clientX: 30 }] })).toBe(false);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    fireEvent.scroll(document);
    expect(onFinish).not.toHaveBeenCalled();
    fireEvent.touchCancel(element, { touches: [] });
    fireEvent.touchEnd(element, { touches: [] });
    expect(onFinish).toHaveBeenCalledExactlyOnceWith(true, true);
    element.remove();
  });

  it("keeps an active native touch drag through pointer cancellation until touch release", () => {
    const element = document.createElement("button");
    document.body.append(element);
    const touch = { identifier: 4, target: element, clientX: 20, clientY: 20 };
    const onFinish = vi.fn();
    const onDragMove = vi.fn();
    trackTouchContextGesture(
      element,
      { target: element, touches: [touch] } as unknown as TouchEvent,
      {
        onMenu: vi.fn(),
        onDragStart: vi.fn(),
        onDragMove,
        onFinish,
      },
    );
    vi.advanceTimersByTime(300);
    fireEvent.touchMove(element, { touches: [{ ...touch, clientX: 30 }] });
    fireEvent.pointerCancel(element, { pointerType: "touch", pointerId: 3 });
    expect(onFinish).not.toHaveBeenCalled();
    fireEvent.touchMove(element, { touches: [{ ...touch, clientX: 50 }] });
    expect(onDragMove).toHaveBeenLastCalledWith({ x: 50, y: 20 });
    expect(fireEvent.touchEnd(element, { touches: [] })).toBe(false);
    expect(onFinish).toHaveBeenCalledExactlyOnceWith(true, false);
    element.remove();
  });

  it.each(["menu", "drag"])("keeps a native contact when %s activation moves focus", (phase) => {
    const input = document.createElement("input");
    const element = document.createElement("button");
    document.body.append(input, element);
    input.focus();
    const touch = { identifier: 4, target: element, clientX: 20, clientY: 20 };
    const onFinish = vi.fn();
    const onDragMove = vi.fn();
    const onMenu = vi.fn(() => {
      if (phase === "menu") input.blur();
    });
    const onDragStart = vi.fn(() => {
      if (phase === "drag") input.blur();
    });
    trackTouchContextGesture(
      element,
      { target: element, touches: [touch] } as unknown as TouchEvent,
      {
        onMenu,
        onDragStart,
        onDragMove,
        onFinish,
      },
    );
    vi.advanceTimersByTime(phase === "menu" ? 500 : 300);
    expect(fireEvent.touchMove(element, { touches: [{ ...touch, clientX: 30 }] })).toBe(false);
    expect(onMenu).toHaveBeenCalledTimes(phase === "menu" ? 1 : 0);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragMove).toHaveBeenCalledWith({ x: 30, y: 20 });
    expect(onFinish).not.toHaveBeenCalled();
    fireEvent.touchEnd(element, { touches: [] });
    expect(onFinish).toHaveBeenCalledExactlyOnceWith(true, false);
    input.remove();
    element.remove();
  });

  it("still cancels when the window itself loses focus", () => {
    const { target } = menus();
    fireEvent.pointerDown(target, pointer);
    fireEvent(window, new Event("blur"));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("allows a targeted editable menu adapter while yielding to native text selection", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.textContent = "Table cell";
    document.body.append(editor);
    const onMenu = vi.fn();
    const start = new PointerEvent("pointerdown", pointer);
    Object.defineProperty(start, "target", { value: editor });
    const cancel = trackTouchContextGesture(editor, start, { onMenu, allowEditable: true });
    const range = document.createRange();
    range.selectNodeContents(editor);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    vi.advanceTimersByTime(500);
    expect(onMenu).not.toHaveBeenCalled();
    document.getSelection()!.removeAllRanges();
    cancel();
    editor.remove();
  });
});
