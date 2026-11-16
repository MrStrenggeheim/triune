// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.queryByTestId("ask-user-question-submit")).toBeNull();
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
    fireEvent.click(screen.getByTestId("ask-user-question-next"));
    fireEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onSubmit).toHaveBeenCalledWith({ first: "A", second: ["B", "Draft"] });
  });

  it("omits skipped and blank custom choices rather than inventing answers", () => {
    const onSubmit = vi.fn();
    render(<AskUserQuestionForm questions={questions} onSubmit={onSubmit} onReject={vi.fn()} />);
    fireEvent.click(screen.getByTestId("ask-user-question-next"));
    fireEvent.click(screen.getByRole("checkbox", { name: "B" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: /^Submit/ }));
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
    expect(screen.getByTestId("ask-user-question-next")).toHaveTextContent("Next (1/2)");
    fireEvent.click(screen.getByTestId("ask-user-question-next"));
    fireEvent.click(screen.getByRole("button", { name: /^Submit/ }));
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

it("keeps the popup footer on one row with an accessible icon only Previous", () => {
  const props = { questions, onSubmit: vi.fn(), onReject: vi.fn() };
  const { rerender } = render(<AskUserQuestionForm {...props} presentation="popup" />);
  const previous = screen.getByRole("button", { name: "Previous" });
  const footer = previous.parentElement!;
  expect(footer).toHaveClass("flex-nowrap");
  expect(footer).not.toHaveClass("flex-wrap");
  expect(previous).toHaveClass("min-w-11");
  expect(previous).toHaveAttribute("data-size", "sm");
  expect(previous.querySelector(".lucide-chevron-left")).toBeInTheDocument();
  expect(previous.textContent).toBe("");
  expect(previous).toBeDisabled();
  expect(footer).toContainElement(screen.getByRole("button", { name: "Decline" }));
  const skip = screen.getByRole("button", { name: "Skip (0/2)" });
  expect(footer).toContainElement(skip);
  act(() => skip.focus());
  fireEvent.click(skip);
  expect(previous).toBeEnabled();
  expect(screen.getByRole("button", { name: "Submit (0/2)" })).toHaveFocus();
  act(() => previous.focus());
  fireEvent.click(previous);
  expect(previous).toHaveFocus();
  expect(previous).toBeDisabled();
  expect(props.onSubmit).not.toHaveBeenCalled();

  rerender(<AskUserQuestionForm {...props} />);
  const messagePrevious = screen.getByRole("button", { name: "Previous" });
  expect(messagePrevious.parentElement).toHaveClass("flex-wrap");
  expect(messagePrevious.parentElement).not.toHaveClass("flex-nowrap");
  expect(messagePrevious).not.toHaveClass("min-w-11");
  expect(messagePrevious).toHaveTextContent("Previous");
});

it("counts every forward action and submits an empty batch only from its final page", () => {
  const submit = vi.fn();
  render(<AskUserQuestionForm questions={questions} onSubmit={submit} onReject={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Skip (0/2)" }));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Submit (0/2)" }));
  expect(submit).toHaveBeenCalledWith({});
});

it("retains choices and the page after unmounting the same request", () => {
  const props = {
    questions,
    onSubmit: vi.fn(),
    onReject: vi.fn(),
    draftKey: "question-draft:reload-test",
  };
  const view = render(<AskUserQuestionForm {...props} />);
  fireEvent.click(screen.getByRole("radio", { name: "A" }));
  expect(props.onSubmit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Next (1/2)" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "B" }));
  view.unmount();
  render(<AskUserQuestionForm {...props} />);
  expect(screen.getByRole("checkbox", { name: "B" })).toBeChecked();
  expect(screen.getByRole("button", { name: "Submit (2/2)" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(screen.getByRole("radio", { name: "A" })).toBeChecked();
});

it("skips an untouched blank editor while retaining its legal empty batch payload", () => {
  const submit = vi.fn();
  render(
    <AskUserQuestionForm
      questions={[{ ...questions[0], options: [], textInput: { default: "" } }, questions[1]]}
      onSubmit={submit}
      onReject={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Skip (0/2)" }));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Submit (0/2)" }));
  expect(submit).toHaveBeenCalledWith({ first: "" });
});
