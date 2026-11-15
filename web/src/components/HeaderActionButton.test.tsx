import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BellIcon, Loader2Icon } from "lucide-react";
import { HeaderActionButton } from "./HeaderActionButton";
import { NotificationBell } from "./NotificationCenter";
import { toast } from "@/lib/notifications";
import { CloseButton } from "./CloseButton";

afterEach(() => {
  cleanup();
  toast.dismiss();
});

it("keeps the button ref and events on the touch target and status indicators independent of main glyph sizing", () => {
  const ref = createRef<HTMLButtonElement>();
  const onClick = vi.fn();
  render(
    <HeaderActionButton ref={ref} aria-label="Notifications" onClick={onClick}>
      <BellIcon className="size-4" />
      <Loader2Icon data-icon-size="status" className="size-2.5" />
    </HeaderActionButton>,
  );
  const button = screen.getByRole("button", { name: "Notifications" });
  expect(ref.current).toBe(button);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(button).toHaveClass("size-6", "max-md:size-11");
  const surface = button.querySelector("[data-header-action-surface]")!;
  expect(surface).toHaveClass("size-6", "[&_svg:not([data-icon-size])]:size-4");
  expect(button.querySelector('[data-icon-size="status"]')).toHaveClass("size-2.5");
  fireEvent.click(surface);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("marks the real bell's running indicator as a 10px status icon", () => {
  render(<NotificationBell />);
  act(() => {
    toast.loading("Uploading files");
  });
  const button = screen.getByRole("button", { name: "Notifications" });
  expect(button).toHaveAttribute("data-header-action-button");
  expect(button.querySelector(".lucide-bell")).toHaveClass("size-4");
  expect(button.querySelector('[data-icon-size="status"]')).toHaveClass("size-2.5");
  expect(button).toHaveAttribute("aria-description", "1 unread, 1 activities in progress");
});

it("forwards close refs and native event guards without turning dismissal into form submission", () => {
  const ref = createRef<HTMLButtonElement>();
  const onParentClick = vi.fn();
  const onClose = vi.fn((event: React.MouseEvent<HTMLButtonElement>) => event.stopPropagation());
  render(
    <div onClick={onParentClick}>
      <CloseButton ref={ref} aria-label="Close research" onClick={onClose} />
    </div>,
  );
  const close = screen.getByRole("button", { name: "Close research" });
  expect(ref.current).toBe(close);
  expect(close).toHaveAttribute("type", "button");
  expect(close).toHaveAttribute("data-size", "icon-xs");
  expect(close).not.toHaveAttribute("data-slot", "tooltip-trigger");
  expect(close.querySelector("[data-close-surface]")).toHaveClass("size-6");
  fireEvent.click(close.querySelector("svg")!);
  expect(onClose).toHaveBeenCalledOnce();
  expect(onParentClick).not.toHaveBeenCalled();
});

it("retains disabled and loading close semantics on the target", () => {
  const onClose = vi.fn();
  render(<CloseButton loading aria-label="Closing research" onClick={onClose} />);
  const close = screen.getByRole("button", { name: "Closing research" });
  expect(close).toBeDisabled();
  expect(close).toHaveAttribute("aria-busy", "true");
  fireEvent.click(close);
  expect(onClose).not.toHaveBeenCalled();
});
