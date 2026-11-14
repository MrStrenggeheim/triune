// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeQuestion } from "@/lib/askUserQuestion";
import { AskUserQuestionForm } from "./AskUserQuestionForm";

afterEach(cleanup);

const questions: ClaudeQuestion[] = [
  { id: "first", question: "Pick", options: [{ label: "A" }], multiSelect: false },
  { id: "second", question: "Pick", options: [{ label: "B" }], multiSelect: true },
];

describe("question submissions", () => {
  it("skips without submitting and preserves choices and custom drafts across navigation and refresh", () => {
    const onSubmit = vi.fn();
    const onReject = vi.fn();
    const { rerender } = render(
      <AskUserQuestionForm questions={questions} onSubmit={onSubmit} onReject={onReject} />,
    );
    const next = screen.getByTestId("ask-user-question-next");
    expect(next).toHaveTextContent("Skip");
    expect(screen.getByTestId("ask-user-question-submit")).toBeEnabled();
    fireEvent.click(next);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "B" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft" } });
    rerender(
      <AskUserQuestionForm
        questions={structuredClone(questions)}
        onSubmit={onSubmit}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("radio", { name: "A" }));
    expect(screen.getByTestId("ask-user-question-next")).toHaveTextContent("Next");
    fireEvent.click(screen.getByTestId("ask-user-question-next"));
    expect(screen.getByRole("checkbox", { name: "B" })).toBeChecked();
    expect(screen.getByRole("textbox")).toHaveValue("Draft");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("radio", { name: "A" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ first: "A", second: ["B", "Draft"] });
  });

  it("omits skipped and blank custom choices rather than inventing answers", () => {
    const onSubmit = vi.fn();
    render(<AskUserQuestionForm questions={questions} onSubmit={onSubmit} onReject={vi.fn()} />);
    fireEvent.click(screen.getByTestId("ask-user-question-next"));
    fireEvent.click(screen.getByRole("checkbox", { name: "B" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ second: ["B"] });
  });

  it.each(["", "  \n "])("preserves an editor's explicit blank value %j", (value) => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionForm
        questions={[
          { ...questions[0], options: [], textInput: { default: "original" } },
          questions[1],
        ]}
        onSubmit={onSubmit}
        onReject={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value } });
    expect(screen.getByTestId("ask-user-question-next")).toHaveTextContent("Next");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ first: value });
  });

  it("declines the entire request even after answering a question", () => {
    const onSubmit = vi.fn();
    const onReject = vi.fn();
    render(<AskUserQuestionForm questions={questions} onSubmit={onSubmit} onReject={onReject} />);
    fireEvent.click(screen.getByRole("radio", { name: "A" }));
    fireEvent.click(screen.getByTestId("ask-user-question-next"));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onReject).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
