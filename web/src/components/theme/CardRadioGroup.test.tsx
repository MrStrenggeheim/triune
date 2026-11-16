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
  expect(selected).toHaveClass("focus-visible:ring-3", "focus-visible:ring-ring/50");
  expect(submit).not.toHaveBeenCalled();
});
