// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerShelf } from "./ComposerShelf";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("retains the last content for the full exit, then removes the hidden slot", () => {
  vi.useFakeTimers();
  const view = render(
    <ComposerShelf present>
      <span>Queued draft</span>
    </ComposerShelf>,
  );
  act(() => vi.advanceTimersByTime(20));
  expect(view.container.firstChild).toHaveAttribute("data-shown", "true");
  view.rerender(<ComposerShelf present={false}>{null}</ComposerShelf>);
  expect(view.container.firstChild).toHaveAttribute("data-shown", "false");
  expect(view.container.firstChild).toHaveAttribute("aria-hidden", "true");
  expect(view.container.firstChild).toHaveAttribute("inert");
  expect(view.container).toHaveTextContent("Queued draft");
  act(() => vi.advanceTimersByTime(199));
  expect(view.container).not.toBeEmptyDOMElement();
  act(() => vi.advanceTimersByTime(1));
  expect(view.container).toBeEmptyDOMElement();
});

it("keeps editor identity, draft, focus and portal contents through updates and a reversed exit", () => {
  vi.useFakeTimers();
  const content = (count: number) => (
    <>
      <input aria-label="Draft" defaultValue="original" />
      <span>{count}</span>
      {createPortal(<div role="dialog">Portal</div>, document.body)}
    </>
  );
  const view = render(<ComposerShelf present>{content(1)}</ComposerShelf>);
  act(() => vi.advanceTimersByTime(20));
  const input = screen.getByRole("textbox", { name: "Draft" });
  input.focus();
  fireEvent.change(input, { target: { value: "typed draft" } });
  view.rerender(<ComposerShelf present>{content(2)}</ComposerShelf>);
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("typed draft");
  expect(input).toHaveFocus();
  expect(view.container.firstChild).toHaveAttribute("data-shown", "true");
  expect(view.container.contains(screen.getByRole("dialog"))).toBe(false);
  view.rerender(<ComposerShelf present={false}>{null}</ComposerShelf>);
  act(() => vi.advanceTimersByTime(100));
  view.rerender(<ComposerShelf present>{content(3)}</ComposerShelf>);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("typed draft");
  expect(view.container.firstChild).not.toHaveAttribute("inert");
});

it("applies reduced motion immediately and leaves no collapsed slot", () => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  const view = render(
    <ComposerShelf present>
      <span>Plan</span>
    </ComposerShelf>,
  );
  expect(view.container.firstChild).toHaveAttribute("data-shown", "true");
  view.rerender(<ComposerShelf present={false}>{null}</ComposerShelf>);
  expect(view.container).toBeEmptyDOMElement();
});

it("dismisses resolved request portals immediately while their shelf surface exits", () => {
  vi.useFakeTimers();
  const view = render(
    <ComposerShelf present retainContent={false}>
      <div>Shelf{createPortal(<div role="dialog">Request</div>, document.body)}</div>
    </ComposerShelf>,
  );
  act(() => vi.advanceTimersByTime(20));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  view.rerender(
    <ComposerShelf present={false} retainContent={false}>
      <div>Surface</div>
    </ComposerShelf>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(view.container).toHaveTextContent("Surface");
  act(() => vi.advanceTimersByTime(200));
  expect(view.container).toBeEmptyDOMElement();
});
