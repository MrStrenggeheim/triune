// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { CheckboxVisual } from "./checkbox";

afterEach(cleanup);

it("limits the active status border to an unchecked decorative checkbox", () => {
  const { container, rerender } = render(<CheckboxVisual active />);
  const marker = container.querySelector('[data-slot="checkbox-visual"]')!;
  const activeBorder = "border-[var(--workspace-control-active-border)]";
  expect(marker).toHaveAttribute("aria-hidden", "true");
  expect(marker).toHaveAttribute("data-state", "unchecked");
  expect(marker).toHaveClass(activeBorder);
  expect(marker.querySelector("svg")).toBeNull();

  rerender(<CheckboxVisual />);
  expect(marker).not.toHaveClass(activeBorder);

  for (const checked of [true, "indeterminate"] as const) {
    rerender(<CheckboxVisual active checked={checked} />);
    expect(marker).not.toHaveClass(activeBorder);
    expect(marker).toHaveAttribute("data-state", checked === true ? "checked" : checked);
    expect(marker.querySelector(".lucide-check")).toBeInTheDocument();
    expect(marker.querySelector(".lucide-minus")).toBeInTheDocument();
  }
  expect(container.querySelector("input, button, [tabindex]")).toBeNull();
});
