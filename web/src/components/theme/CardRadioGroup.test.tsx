import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CardRadioGroup } from "./CardRadioGroup";

afterEach(cleanup);

it("shares the softer selected border and retains keyboard selection/focus without form submission", () => {
  const submit = vi.fn((event) => event.preventDefault());
  function Harness() {
    const [value, setValue] = useState("first");
    return (
      <form onSubmit={submit}>
        <span id="appearance">Appearance</span>
        <CardRadioGroup
          labelledBy="appearance"
          value={value}
          onSelect={setValue}
          items={[
            { value: "first", testId: "first", body: "First" },
            { value: "second", testId: "second", body: "Second" },
          ]}
        />
      </form>
    );
  }
  render(<Harness />);
  expect(screen.getByRole("radio", { name: "First" })).toHaveClass(
    "border-[var(--workspace-control-active-border)]",
  );
  fireEvent.keyDown(screen.getByRole("radio", { name: "First" }), { key: "ArrowRight" });
  const selected = screen.getByRole("radio", { name: "Second" });
  expect(selected).toHaveAttribute("aria-checked", "true");
  expect(selected).toHaveFocus();
  expect(selected).toHaveClass("focus-visible:ring-control-focus", "focus-visible:ring-ring/12");
  expect(submit).not.toHaveBeenCalled();
});

it.each([
  ["vertical", "flex", "flex-col"],
  ["gallery", "grid", "grid-cols-2"],
] as const)("lays out six options as a %s group", (layout, displayClass, directionClass) => {
  render(
    <>
      <span id="workspace-choices">Workspace choices</span>
      <CardRadioGroup
        labelledBy="workspace-choices"
        value="files"
        onSelect={vi.fn()}
        layout={layout}
        items={["files", "terminal", "changes", "appearance", "shortcuts", "notices"].map(
          (value) => ({ value, testId: value, body: value }),
        )}
      />
    </>,
  );

  const group = screen.getByRole("radiogroup", { name: "Workspace choices" });
  expect(group).toHaveAttribute("data-layout", layout);
  expect(group).toHaveClass(displayClass, directionClass);
  expect(screen.getAllByRole("radio")).toHaveLength(6);
});
