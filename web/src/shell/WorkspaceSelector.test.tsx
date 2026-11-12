// Modified for Triune.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSelector } from "./WorkspaceSelector";

afterEach(cleanup);

it("keeps the full Host:path accessible with the existing trigger geometry", async () => {
  const onClick = vi.fn();
  render(<WorkspaceSelector hostLabel="Host" path="/work/repo" onClick={onClick} />);
  const trigger = screen.getByRole("button", { name: "Select workspace: Host:/work/repo" });
  expect(trigger).toHaveTextContent("Host · /work/repo");
  expect(screen.getByText("Host")).toHaveClass("text-muted-foreground");
  expect(screen.getByText("/work/repo")).toHaveClass("text-foreground");
  expect(trigger).toHaveClass("text-ui", "font-normal");
  expect(trigger.querySelector(".lucide-monitor")).not.toBeNull();
  expect(trigger.querySelectorAll("svg")).toHaveLength(2);
  expect(trigger.querySelector(".lucide-folder")).toBeNull();
  expect(trigger).toHaveClass("min-h-11", "md:min-h-7", "gap-1.5", "px-2", "border-0");
  expect(trigger).not.toHaveAttribute("title");
  await userEvent.tab();
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("tooltip")).toBeNull();
  await userEvent.click(trigger);
  expect(onClick).toHaveBeenCalledOnce();
});

it.each(["truncated", "collapsed"])(
  "uses one canonical tooltip for a %s location",
  async (state) => {
    render(<WorkspaceSelector hostLabel="Host" path="/work/repo" />);
    const trigger = screen.getByRole("button");
    const label = trigger.querySelector<HTMLElement>("[data-workspace-collapse-label]")!;
    if (state === "truncated") {
      Object.defineProperty(label, "clientWidth", { value: 40 });
      Object.defineProperty(label, "scrollWidth", { value: 140 });
    } else {
      label.style.display = "none";
    }
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Host:/work/repo");
    expect(document.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1);
    expect(trigger).toHaveAccessibleName("Select workspace: Host:/work/repo");
    expect(trigger).not.toHaveAttribute("title");
    expect(label).toHaveClass("group-data-[labels=collapsed]/composer-actions:hidden");
  },
);

it("keeps disabled explanations reachable by keyboard without enabling the action", async () => {
  const onClick = vi.fn();
  const reason = "Wait for the current turn and approvals to finish";
  render(
    <WorkspaceSelector
      hostLabel="Host"
      path="/work"
      disabled
      disabledReason={reason}
      onClick={onClick}
    />,
  );
  const trigger = screen.getByRole("button");
  expect(trigger).toBeDisabled();
  expect(trigger).not.toHaveAttribute("title");
  await userEvent.tab();
  expect(screen.getByRole("group")).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
  fireEvent.click(trigger);
  expect(onClick).not.toHaveBeenCalled();
});

it("suppresses location guidance while the picker is open and during return focus", async () => {
  const { rerender } = render(<WorkspaceSelector hostLabel="Host" path="/work" />);
  const label = screen
    .getByRole("button")
    .querySelector<HTMLElement>("[data-workspace-collapse-label]")!;
  label.style.display = "none";
  await userEvent.tab();
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Host:/work");
  rerender(<WorkspaceSelector hostLabel="Host" path="/work" menuOpen />);
  expect(screen.queryByRole("tooltip")).toBeNull();
  rerender(<WorkspaceSelector hostLabel="Host" path="/work" />);
  fireEvent.blur(screen.getByRole("button"));
  fireEvent.focus(screen.getByRole("button"));
  expect(screen.queryByRole("tooltip")).toBeNull();
});
