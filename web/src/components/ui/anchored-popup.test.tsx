import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  AnchoredPopupProvider,
  useAnchoredPopupBounds,
  usePopupTriggerRef,
} from "./anchored-popup";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

afterEach(cleanup);

function Probe() {
  const ref = usePopupTriggerRef<HTMLButtonElement>(undefined);
  const bounds = useAnchoredPopupBounds();
  return (
    <>
      <button ref={ref}>Trigger</button>
      <output data-testid="bounds">{JSON.stringify(bounds.collisionPadding)}</output>
    </>
  );
}

it("uses viewport/composer intersection as horizontal collision padding and updates on resize", () => {
  let left = 100;
  let width = 400;
  render(
    <AnchoredPopupProvider open>
      <div
        className="composer-shelf-stack"
        style={{ paddingLeft: 12, paddingRight: 12 }}
        ref={(node) => {
          if (node) node.getBoundingClientRect = () => new DOMRect(left, 600, width, 40);
        }}
      >
        <Probe />
      </div>
    </AnchoredPopupProvider>,
  );
  const bounds = () => JSON.parse(screen.getByTestId("bounds").textContent!);
  expect(bounds()).toEqual({ top: 8, bottom: 8, left: 112, right: window.innerWidth - 488 });
  act(() => {
    left = -20;
    width = 300;
    window.dispatchEvent(new Event("resize"));
  });
  expect(bounds()).toEqual({ top: 8, bottom: 8, left: 8, right: window.innerWidth - 268 });
});

it("centers top/bottom popovers and dropdowns despite legacy edge alignment, retaining preferred side", () => {
  const view = render(
    <Popover defaultOpen>
      <PopoverTrigger>Usage</PopoverTrigger>
      <PopoverContent side="top" align="end">
        Usage content
      </PopoverContent>
    </Popover>,
  );
  expect(screen.getByRole("dialog")).toHaveAttribute("data-align", "center");
  expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "top");
  view.unmount();
  render(
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem>Files</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  expect(screen.getByRole("menu")).toHaveAttribute("data-align", "center");
  expect(screen.getByRole("menu").style.maxWidth).toContain("--radix-popper-available-width");
  fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
  expect(screen.queryByRole("menu")).toBeNull();
});
