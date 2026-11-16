// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef, useCallback, type CSSProperties } from "react";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Probe() {
  const ref = usePopupTriggerRef<HTMLButtonElement>(undefined);
  const bounds = useAnchoredPopupBounds();
  return (
    <>
      <button type="button" ref={ref}>
        Trigger
      </button>
      <output data-testid="bounds">{JSON.stringify(bounds.collisionPadding)}</output>
    </>
  );
}

function RowProbe({
  target,
  paint = target,
  side = "bottom",
  enabled = true,
}: {
  target: DOMRect;
  paint?: DOMRect;
  side?: "top" | "bottom" | "left";
  enabled?: boolean;
}) {
  const ref = usePopupTriggerRef<HTMLButtonElement>(undefined);
  const bounds = useAnchoredPopupBounds(8, undefined, enabled, side, 7);
  const triggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (node) node.getBoundingClientRect = () => target;
      ref(node);
    },
    [ref, target],
  );
  return (
    <>
      <button type="button" ref={triggerRef}>
        Trigger
        <span
          data-header-action-surface
          ref={(node) => {
            if (node) node.getBoundingClientRect = () => paint;
          }}
        />
      </button>
      <div ref={bounds.ref} data-testid="geometry">
        {JSON.stringify(bounds)}
      </div>
    </>
  );
}

function rowGeometry({
  row,
  target,
  paint,
  className = "workspace-control-header",
  side = "bottom",
  enabled = true,
  style,
}: {
  row: DOMRect;
  target: DOMRect;
  paint?: DOMRect;
  className?: string;
  side?: "top" | "bottom" | "left";
  enabled?: boolean;
  style?: CSSProperties;
}) {
  render(
    <AnchoredPopupProvider open>
      <div
        className={className}
        style={style}
        ref={(node) => {
          if (node) node.getBoundingClientRect = () => row;
        }}
      >
        <RowProbe target={target} paint={paint} side={side} enabled={enabled} />
      </div>
    </AnchoredPopupProvider>,
  );
  return () => JSON.parse(screen.getByTestId("geometry").textContent!);
}

it.each([48, 36])("mirrors the visible 24px control inset outside a %ipx header", (height) => {
  const inset = (height - 24) / 2;
  const geometry = rowGeometry({
    row: new DOMRect(100, 100, 400, height),
    target: new DOMRect(200, 100 + inset, 24, 24),
  });
  expect(geometry().sideOffset).toBe(inset * 2);
  expect(geometry()["data-popup-row-anchor"]).toBe(true);
});

it("uses visible paint instead of the coarse target, including the separator's half pixel", async () => {
  const geometry = rowGeometry({
    row: new DOMRect(100, 100, 400, 48),
    target: new DOMRect(200, 101.5, 44, 44),
    paint: new DOMRect(210, 111.5, 24, 24),
  });
  expect(geometry().sideOffset).toBe(15);
  expect(geometry().collisionPadding.top).toBe(8);
  await act(async () => screen.getByTestId("geometry").setAttribute("data-side", "top"));
  expect(geometry().sideOffset).toBe(13);
  expect(geometry().collisionPadding.top).toBe(10);
  // Constant clearance prevents an asymmetric flip from changing Radix's fit decision.
  expect(geometry().sideOffset + geometry().collisionPadding.top).toBe(23);
});

it("mirrors shelf borders but excludes the overlap behind the next composer layer", async () => {
  const geometry = rowGeometry({
    className: "composer-shelf-content",
    row: new DOMRect(100, 500, 400, 54),
    target: new DOMRect(105, 505, 80, 24),
    style: { marginBottom: -20 },
    side: "top",
  });
  expect(geometry().sideOffset).toBe(10);
  await act(async () => screen.getByTestId("geometry").setAttribute("data-side", "bottom"));
  expect(geometry().sideOffset).toBe(10);
});

it("observes the mounted popup independently of trigger telemetry and disconnects on close", async () => {
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  const children = (
    <div
      className="workspace-control-header"
      ref={(node) => {
        if (node) node.getBoundingClientRect = () => new DOMRect(0, 100, 400, 60);
      }}
    >
      <RowProbe target={new DOMRect(100, 106, 24, 24)} />
    </div>
  );
  const view = render(<AnchoredPopupProvider open>{children}</AnchoredPopupProvider>);
  const geometry = () => JSON.parse(screen.getByTestId("geometry").textContent!);
  expect(geometry().sideOffset).toBe(60);
  await act(async () => screen.getByRole("button").setAttribute("data-radix-popper-side", "top"));
  expect(geometry().sideOffset).toBe(60);
  await act(async () => screen.getByTestId("geometry").setAttribute("data-side", "top"));
  expect(geometry().sideOffset).toBe(12);
  expect(geometry().sideOffset + geometry().collisionPadding.top).toBe(68);
  disconnect.mockClear();
  view.rerender(<AnchoredPopupProvider open={false}>{children}</AnchoredPopupProvider>);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(geometry().sideOffset).toBe(7);
  expect(geometry()["data-popup-row-anchor"]).toBeUndefined();
  await act(async () => screen.getByTestId("geometry").setAttribute("data-side", "bottom"));
  expect(geometry().sideOffset).toBe(7);
});

it.each([
  { className: "body-control", side: "bottom" as const, enabled: true },
  { className: "workspace-control-header", side: "left" as const, enabled: true },
  { className: "workspace-control-header", side: "bottom" as const, enabled: false },
])("keeps ordinary, side-opening and disabled popup spacing: %j", (options) => {
  const geometry = rowGeometry({
    row: new DOMRect(0, 0, 400, 48),
    target: new DOMRect(0, 12, 24, 24),
    ...options,
  });
  expect(geometry().sideOffset).toBe(7);
  expect(geometry()["data-popup-row-anchor"]).toBeUndefined();
});

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
  const ref = createRef<HTMLDivElement>();
  render(
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent align="start" ref={ref}>
        <DropdownMenuItem>Files</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  expect(screen.getByRole("menu")).toHaveAttribute("data-align", "center");
  expect(screen.getByRole("menu").style.maxWidth).toContain("--radix-popper-available-width");
  expect(ref.current).toBe(screen.getByRole("menu"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(ref.current).toBeNull();
});
