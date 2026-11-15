// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionBatchCard } from "./QuestionBatchCard";

afterEach(cleanup);
const questions = [
  { id: "q0", question: "Original question?", header: "Scope", options: [], multiSelect: false },
  { id: "q1", question: "Another original?", options: [], multiSelect: false },
];
it("retains the same card/disclosure/header pager when a pending batch becomes answered", () => {
  const change = vi.fn();
  const { container, rerender } = render(
    <QuestionBatchCard
      questions={questions}
      index={0}
      onIndexChange={change}
      status="pending"
      response={null}
    >
      <p>Answer form</p>
    </QuestionBatchCard>,
  );
  const card = container.querySelector(".activity-row");
  const header = container.querySelector(".activity-message-header");
  const toggle = screen.getByRole("button", { name: "Collapse activity" });
  expect(screen.getAllByText("Question 1 of 2")).toHaveLength(1);
  rerender(
    <QuestionBatchCard
      questions={questions}
      index={0}
      onIndexChange={change}
      status="responded"
      response={{ action: "accept", content: { q0: "Exact answer" } }}
    />,
  );
  expect(container.querySelector(".activity-row")).toBe(card);
  expect(container.querySelector(".activity-message-header")).toBe(header);
  expect(screen.getByRole("button", { name: "Collapse activity" })).toBe(toggle);
  expect(screen.getByText("Answered")).toHaveClass("font-semibold");
  expect(screen.getByText("Scope").nextElementSibling).toHaveTextContent("Original question?");
  expect(screen.getByText("Exact answer")).toHaveClass("text-foreground");
  fireEvent.click(screen.getByRole("button", { name: "Next question" }));
  expect(change).toHaveBeenCalledWith(1);
  fireEvent.click(toggle);
  expect(container.querySelector(".activity-message-header")).toContainElement(
    screen.getByText("Question 1 of 2"),
  );
});
it("omits single-question pagination and missing categories, and distinguishes empty from unanswered", () => {
  const { rerender } = render(
    <QuestionBatchCard
      questions={[questions[1]]}
      index={0}
      onIndexChange={vi.fn()}
      status="responded"
      response={{ action: "accept", content: { q1: "" } }}
    />,
  );
  expect(screen.queryByText(/Question 1 of/)).toBeNull();
  expect(screen.queryByText("Scope")).toBeNull();
  expect(screen.getByText("Empty answer")).toBeVisible();
  rerender(
    <QuestionBatchCard
      questions={[questions[1]]}
      index={0}
      onIndexChange={vi.fn()}
      status="responded"
      response={{ action: "accept", content: {} }}
    />,
  );
  expect(screen.getByText("Unanswered")).toBeVisible();
});
it("never displays a secret value in the answered card or its title attributes", () => {
  const { container } = render(
    <QuestionBatchCard
      questions={[{ ...questions[0], isSecret: true }]}
      index={0}
      onIndexChange={vi.fn()}
      status="responded"
      response={{ action: "accept", content: { q0: "DO-NOT-DISPLAY" } }}
    />,
  );
  expect(screen.getByText("Answer hidden")).toBeVisible();
  expect(container.innerHTML).not.toContain("DO-NOT-DISPLAY");
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
  expect(container.innerHTML).not.toContain("DO-NOT-DISPLAY");
});
