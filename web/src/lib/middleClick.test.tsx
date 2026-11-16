import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { middleClickHandlers } from "./middleClick";

describe("shared internal middle click", () => {
  it("blocks middle down defaults, opens once on auxclick and preserves primary/secondary input", () => {
    const open = vi.fn();
    const left = vi.fn();
    render(
      <button type="button" {...middleClickHandlers(open)} onClick={left}>
        Resource
      </button>,
    );
    const target = screen.getByRole("button", { name: "Resource" });
    expect(fireEvent.mouseDown(target, { button: 1 })).toBe(false);
    expect(open).not.toHaveBeenCalled();
    fireEvent(target, new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(fireEvent.mouseDown(target, { button: 2 })).toBe(true);
    fireEvent(target, new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true }));
    fireEvent.click(target);
    expect(open).toHaveBeenCalledTimes(1);
    expect(left).toHaveBeenCalledTimes(1);
  });
});
