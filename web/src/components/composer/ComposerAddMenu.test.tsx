import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerAddMenu } from "./ComposerAddMenu";

afterEach(cleanup);

it("uses the shared centered composer bounds and retains attachment/plan actions without submitting", () => {
  const onAttach = vi.fn(),
    onPlan = vi.fn(),
    submit = vi.fn((event) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <div data-composer-card>
        <textarea aria-label="Draft" defaultValue="Keep this text" />
        <ComposerAddMenu disabled={false} onAttach={onAttach} onPlan={onPlan} planActive={false} />
      </div>
    </form>,
  );
  const open = () =>
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add" }), {
      button: 0,
      pointerType: "mouse",
      ctrlKey: false,
    });
  open();
  const menu = screen.getByRole("menu", { name: "Add" });
  expect(menu).toHaveAttribute("data-align", "center");
  expect(menu).toHaveAttribute("data-side", "top");
  expect(menu.style.width).toBe("var(--radix-popper-available-width)");
  fireEvent.click(screen.getByRole("menuitem", { name: "Files and images" }));
  expect(onAttach).toHaveBeenCalledOnce();
  open();
  fireEvent.click(screen.getByTestId("composer-plan-action"));
  expect(onPlan).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep this text");
});
