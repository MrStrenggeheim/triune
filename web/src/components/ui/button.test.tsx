// Modified for Triune; inherited notices remain applicable.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button, buttonVariants } from "./button";
import { setOmnigentHostConfig } from "@/lib/host";

afterEach(() => {
  cleanup();
  setOmnigentHostConfig({});
});

// Matches a Tailwind translate utility (`translate-y-px`, `-translate-x-1/2`,
// `translate-3`), bare or behind variant prefixes (`active:translate-y-px`).
const TRANSLATE_UTILITY = /(^|:)-?translate-/;

const VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
const SIZES = [
  "default",
  "xs",
  "sm",
  "lg",
  "icon",
  "icon-xxs",
  "icon-xs",
  "icon-sm",
  "icon-lg",
] as const;

describe("buttonVariants translate/transform composition", () => {
  it.each(VARIANTS.flatMap((variant) => SIZES.map((size) => ({ variant, size }))))(
    "emits no translate-* utility for variant=$variant size=$size",
    ({ variant, size }) => {
      const classes = buttonVariants({ variant, size }).split(/\s+/);
      // A translate utility here (e.g. reintroducing active:translate-y-px)
      // would clobber caller positioning transforms on press: the sidebar
      // quick-pin button jumps mid-click and the click never registers.
      const offenders = classes.filter((c) => TRANSLATE_UTILITY.test(c));
      expect(offenders).toEqual([]);
    },
  );

  it("keeps press feedback without moving the button", () => {
    for (const variant of VARIANTS) {
      expect(buttonVariants({ variant })).not.toMatch(/active:[^\s]*(?:transform|translate)/);
    }
    expect(buttonVariants({})).toContain("active:bg-[var(--primary-active)]");
  });

  it("preserves a caller's -translate-y-1/2 centering class through the merge", () => {
    // Guards against tailwind-merge treating the press nudge and the caller's
    // centering class as conflicting and dropping the latter — that would
    // leave the pin button permanently mispositioned, not just while pressed.
    const merged = buttonVariants({
      variant: "ghost",
      size: "icon-sm",
      className: "absolute top-1/2 -translate-y-1/2 right-9",
    });
    expect(merged).toContain("-translate-y-1/2");
  });
});

describe("buttonVariants icon geometry", () => {
  it("uses regular-weight labels for every button size", () => {
    for (const size of SIZES) {
      const classes = buttonVariants({ size });
      expect(classes).toContain("font-normal");
      expect(classes).not.toContain("font-medium");
    }
  });

  it("keeps the shared icon sizing hook on buttons", () => {
    const classes = buttonVariants({});
    // index.css owns the fixed geometry through this semantic hook; callers can
    // opt an exceptional icon out with data-icon-size.
    expect(classes).toContain("button-standard-icons");
  });

  it("makes icon-xxs a transparent 14px container with a 14px glyph", () => {
    render(
      <Button variant="ghost" size="icon-xxs" aria-label="Tiny icon">
        <svg aria-hidden />
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Tiny icon" })).toHaveClass(
      "size-3.5",
      "bg-transparent",
      "hover:bg-transparent",
      "dark:hover:bg-transparent",
      "[&_svg]:size-3.5!",
      "[&_svg]:p-0!",
    );
  });

  it("mutes ghost icon buttons by default without changing primary icon contrast", () => {
    render(
      <>
        <Button variant="ghost" size="icon" aria-label="Ghost icon">
          <svg aria-hidden />
        </Button>
        <Button size="icon" aria-label="Primary icon">
          <svg aria-hidden />
        </Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Ghost icon" })).toHaveClass(
      "text-muted-foreground",
      "hover:text-foreground",
    );
    expect(screen.getByRole("button", { name: "Primary icon" })).toHaveClass(
      "text-primary-foreground",
    );
    expect(screen.getByRole("button", { name: "Primary icon" })).not.toHaveClass(
      "text-muted-foreground",
    );
  });
});

describe("Medium content", () => {
  it("keeps icon order, count interpolation and the hidden loading width", () => {
    const children = (
      <>
        <svg aria-hidden />
        Delete <>{2} sessions</>
        <svg aria-hidden />
      </>
    );
    const view = render(<Button>{children}</Button>);
    const button = screen.getByRole("button", { name: "Delete 2 sessions" });
    const ink = screen.getByText("Delete 2 sessions");
    expect(ink).toHaveClass("button-label-ink");
    expect(ink.parentElement?.previousElementSibling?.tagName).toBe("svg");
    expect(ink.parentElement?.nextElementSibling?.tagName).toBe("svg");
    view.rerender(<Button loading>{children}</Button>);
    expect(screen.getByText("Delete 2 sessions").closest(".contents")).toHaveClass("invisible");
    expect(button).toHaveAccessibleName("Delete 2 sessions");
  });

  it("keeps truncated labels and caller-owned content in their original flex slots", () => {
    function CustomIcon() {
      return <svg data-icon-size="custom" role="presentation" />;
    }
    render(
      <Button>
        <CustomIcon />
        <span title="Repository" className="truncate">
          Repository
        </span>
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Repository" });
    expect(button.firstElementChild).toHaveAttribute("data-icon-size", "custom");
    expect(screen.getByTitle("Repository").parentElement).toBe(button);
    expect(screen.getByText("Repository")).toHaveClass("button-label-ink");
  });

  it("forwards the actual anchor ref and modified clicks through Slot", () => {
    const click = vi.fn((event: React.MouseEvent) => event.preventDefault());
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button asChild ref={ref}>
        <a href="/archive" onClick={click}>
          <svg aria-hidden />
          Archive
        </a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Archive" });
    expect(ref.current).toBe(link);
    expect(link).toHaveAttribute("href", "/archive");
    expect(link).not.toHaveAttribute("type");
    fireEvent.click(link, { ctrlKey: true });
    expect(click.mock.calls[0][0].ctrlKey).toBe(true);
    expect(screen.getByText("Archive")).toHaveClass("button-label-ink");
  });
});

describe("menu button feedback", () => {
  it.each(["pointerup", "pointercancel", "lostpointercapture"])(
    "clears the held trigger on %s outside the button without consuming the event",
    (release) => {
      const down = vi.fn();
      render(
        <Button
          aria-haspopup="menu"
          variant="ghost"
          size="sm"
          data-slot="dropdown-menu-trigger"
          onPointerDownCapture={down}
          aria-expanded
        >
          Compare
        </Button>,
      );
      const button = screen.getByRole("button", { name: "Compare" });
      function pointer(target: HTMLElement, type: string, pointerId: number) {
        const event = Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true }), {
          isPrimary: true,
          pointerId,
        });
        fireEvent(target, event);
        expect(event.defaultPrevented).toBe(false);
      }
      pointer(button, "pointerdown", 4);
      expect(down).toHaveBeenCalledOnce();
      expect(button).toHaveAttribute("data-button-held");
      pointer(document.body, release, 5);
      expect(button).toHaveAttribute("data-button-held");
      pointer(document.body, release, 4);
      expect(button).not.toHaveAttribute("data-button-held");
      expect(button).toHaveAttribute("aria-expanded", "true");
      expect(button).toHaveAttribute("data-slot", "dropdown-menu-trigger");
    },
  );
});

describe("Button radius scale", () => {
  it("maps default, small, and extra-small buttons to 8px, 6px, and 4px tokens", () => {
    render(
      <>
        <Button data-testid="button-md">Medium</Button>
        <Button size="sm" data-testid="button-sm">
          Small
        </Button>
        <Button size="xs" data-testid="button-xs">
          Extra small
        </Button>
        <Button size="icon-xs" aria-label="Compact icon" data-testid="button-icon-xs">
          <svg aria-hidden />
        </Button>
      </>,
    );

    expect(screen.getByTestId("button-md")).toHaveClass("rounded-lg");
    expect(screen.getByTestId("button-sm")).toHaveClass("rounded-[var(--radius-md)]");
    expect(screen.getByTestId("button-xs")).toHaveClass("rounded-[var(--radius-sm)]");
    expect(screen.getByTestId("button-icon-xs")).toHaveClass("rounded-[var(--radius-md)]");
  });
});

describe("Button loading state", () => {
  it("keeps the rendered accessible name of an opaque custom label while busy", () => {
    function ActionLabel() {
      return <strong>Save draft</strong>;
    }
    render(
      <Button loading>
        <ActionLabel />
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("keeps the label in the DOM so the button width doesn't collapse or grow", () => {
    // The label must stay rendered (just hidden) — replacing it with the
    // spinner would shrink the button to the spinner's width and shift
    // neighbouring buttons, which is exactly the bug this prop fixes.
    render(<Button loading>Update goal</Button>);
    expect(screen.getByRole("button", { name: "Update goal" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByText("Update goal")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update goal" }).querySelector("svg"),
    ).toHaveAttribute("aria-hidden", "true");
  });

  it("disables the button and marks it busy while loading", () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("does not render a spinner when not loading", () => {
    render(<Button>Save</Button>);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).not.toBeDisabled();
  });

  it("respects an explicit disabled prop independent of loading", () => {
    render(
      <Button disabled loading={false}>
        Save
      </Button>,
    );
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not inject a spinner overlay when asChild is set", () => {
    // asChild renders the child as the element via Radix Slot, which requires
    // a single child; injecting an overlay would break that contract.
    render(
      <Button asChild loading>
        <a href="/x">Link</a>
      </Button>,
    );
    expect(screen.getByRole("link")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("Button analytics (componentId)", () => {
  it("reports a click to the host sink and still calls the caller's onClick", () => {
    const analytics = vi.fn();
    setOmnigentHostConfig({ analytics });
    const onClick = vi.fn();
    render(
      <Button componentId="composer.send" onClick={onClick}>
        Send
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(analytics).toHaveBeenCalledExactlyOnceWith({
      type: "click",
      componentId: "composer.send",
      componentKind: "button",
    });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("emits nothing when componentId is absent", () => {
    const analytics = vi.fn();
    setOmnigentHostConfig({ analytics });
    render(<Button>Send</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(analytics).not.toHaveBeenCalled();
  });
});
