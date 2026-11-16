import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FileIcon } from "lucide-react";
import { WorkbenchAppBar } from "./WorkbenchAppBar";

afterEach(cleanup);

it("reuses the small leading-icon button and coarse target while preserving Open actions", () => {
  const run = vi.fn();
  render(
    <WorkbenchAppBar
      sidebarOpen
      onToggleSidebar={vi.fn()}
      onSearch={vi.fn()}
      onSettings={vi.fn()}
      openActions={[{ id: "files", label: "Files", icon: FileIcon, run }]}
    />,
  );
  const button = screen.getByRole("button", { name: "Open view" });
  expect(button).toHaveAttribute("data-size", "sm");
  expect(button).toHaveClass(
    "gap-1",
    "px-2.5",
    "has-data-[icon=inline-start]:pl-1.5",
    "max-md:size-11!",
  );
  expect(button).not.toHaveClass("p-[5px]", "h-8", "gap-1.5");
  const icon = button.querySelector("svg")!;
  expect(icon).toHaveAttribute("data-icon", "inline-start");
  expect(icon).not.toHaveAttribute("data-icon-size");
  expect(icon).not.toHaveClass("size-4", "p-0");
  fireEvent.pointerDown(button, { button: 0, pointerType: "mouse", ctrlKey: false });
  fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
  expect(run).toHaveBeenCalledOnce();
});
