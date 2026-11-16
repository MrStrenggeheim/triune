import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarShortcutCommands } from "./sidebarShortcutAdapter";

const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
describe("Sidebar registry adapter", () => {
  it("navigates logical session brackets, protects layout-dependent zoom, and preserves pinned physical keys", () => {
    const navigate = vi.fn();
    renderHook(() =>
      useSidebarShortcutCommands({
        orderedIds: ["a", "b"],
        orderedPinnedIds: ["b"],
        activeId: "a",
        navigate,
      }),
    );
    for (const key of ["+", "=", "-", "_", "0"])
      expect(press({ key, code: "BracketRight", ctrlKey: true }).defaultPrevented).toBe(false);
    document.body.dispatchEvent(
      new WheelEvent("wheel", { ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(navigate).not.toHaveBeenCalled();
    press({ key: "]", code: "Equal", ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith("/c/b");
    press({ key: "¡", code: "Digit1", ctrlKey: true, altKey: true });
    expect(navigate).toHaveBeenCalledTimes(2);
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    terminal.tabIndex = 0;
    document.body.append(terminal);
    terminal.focus();
    press({ key: "]", ctrlKey: true });
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});
