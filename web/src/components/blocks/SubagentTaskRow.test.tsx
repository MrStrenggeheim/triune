// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AgentActivity } from "@/shell/subagentStatus";
import { SubagentTaskRow, SubagentTaskStatus } from "./SubagentTaskRow";

afterEach(cleanup);
it("shows captured execution beside the task and omits absent metadata", () => {
  const props = {
    agentName: "Reviewer",
    description: "Inspect changes",
    status: { activity: "working" as const, label: "Running" },
  };
  const view = render(
    <SubagentTaskRow {...props} execution={{ model: "gpt-6.1-sol", effort: "low" }} />,
  );
  expect(screen.getByTestId("agent-execution")).toHaveTextContent("gpt-6.1-sol · Low");
  view.rerender(<SubagentTaskRow {...props} />);
  expect(screen.queryByTestId("agent-execution")).not.toBeInTheDocument();
});
it.each([
  ["working", "Working", "Running", "bg-session-active/10"],
  ["launching", "Launching", "Launching", "bg-session-active/10"],
  ["done", "Done", "Completed", "bg-success/10"],
  ["failed", "Failed", "Failed", "bg-destructive/10"],
  ["awaiting", "Needs response", "Needs response", "bg-warning/10"],
  ["disconnected", "Disconnected", "Disconnected", "bg-secondary"],
  ["idle", "Idle", "Idle", "bg-secondary"],
  ["other", "Stopped", "Stopped", "bg-secondary"],
] as const)(
  "renders %s with a shared semantic Badge and icon",
  (activity, label, expected, tone) => {
    render(<SubagentTaskStatus status={{ activity: activity as AgentActivity, label }} />);
    const pill = screen.getByRole("status", { name: expected });
    expect(pill).toHaveAttribute("data-slot", "badge");
    expect(pill).toHaveClass(tone);
    expect(pill.querySelector("svg, [data-testid=running-dot]")).not.toBeNull();
    if (activity === "working" || activity === "launching") {
      expect(screen.getByTestId("running-dot")).toHaveClass("text-inherit");
      expect(screen.getByTestId("running-dot")).not.toHaveClass("text-muted-foreground");
    }
  },
);
it.each(["Running", "Exited", "Unknown"])(
  "honors a shell label override %s without changing the status contract",
  (label) => {
    render(
      <SubagentTaskStatus
        status={{ activity: "done", label: "Done", details: "Exit code 0" }}
        label={label}
      />,
    );
    expect(screen.getByRole("status", { name: label })).toHaveAttribute(
      "aria-description",
      "Exit code 0",
    );
    expect(screen.getByRole("status", { name: label })).toHaveClass("bg-success/10");
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  },
);
