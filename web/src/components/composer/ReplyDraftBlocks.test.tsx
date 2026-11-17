// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { moveReplyQuote, removeReplyQuote, type ReplyDraft } from "@/lib/replyDraft";
import { useReplyDraft } from "@/hooks/useReplyDraft";
import { ReplyDraftBlocks } from "./ReplyDraftBlocks";

vi.mock("@/lib/textareaDropCaret", () => ({
  textareaDropCaret: (input: HTMLTextAreaElement, point?: { x: number }) => ({
    offset: point ? 5 : input.selectionStart,
    left: 120,
    top: 42,
    height: 20,
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const initial: ReplyDraft = {
  quotes: [{ id: "q", before: "Intro", text: "Selected quote" }],
  text: "Tail answer",
};
function Composer() {
  const [draft, setDraft] = useState(initial);
  return (
    <div data-composer-input-area>
      <ReplyDraftBlocks
        quotes={draft.quotes}
        disabled={false}
        activeTextId={null}
        keyboard={{ submitWithModEnter: false, preventsKeyboardSubmit: false }}
        inputFor={() => ({ onChange: () => {} })}
        onRemove={(id) => setDraft((current) => removeReplyQuote(current, id))}
        onMove={(id, target, offset) =>
          setDraft((current) => moveReplyQuote(current, id, target, offset))
        }
      />
      <textarea aria-label="Tail" value={draft.text} onChange={() => {}} />
    </div>
  );
}

it.each(["mouse", "touch"])(
  "moves a quote to a measured tail caret with a %s pointer",
  (pointerType) => {
    render(<Composer />);
    const handle = screen.getByRole("button", { name: "Move quote 1" });
    const tail = screen.getByRole("textbox", { name: "Tail" });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => tail),
    });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, pointerType, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType, clientX: 120, clientY: 42 });
    expect(document.querySelector("[data-quote-insertion-caret]")).toHaveStyle({
      left: "120px",
      top: "42px",
      height: "20px",
    });
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType, clientX: 120, clientY: 42 });
    expect(screen.getByRole("textbox", { name: "Reply text before quote 1" })).toHaveValue(
      "IntroTail ",
    );
    expect(tail).toHaveValue("answer");
    expect(screen.getByTestId("composer-reply-quote")).toHaveTextContent("Selected quote");
    expect(document.querySelector("[data-quote-insertion-caret]")).toBeNull();
  },
);

it("supports keyboard placement and Escape cancellation without submitting", () => {
  render(<Composer />);
  fireEvent.click(screen.getByRole("button", { name: "Move quote 1" }), { detail: 0 });
  const tail = screen.getByRole("textbox", { name: "Tail" }) as HTMLTextAreaElement;
  tail.setSelectionRange(2, 2);
  fireEvent.keyDown(tail, { key: "Enter" });
  expect(tail).toHaveValue("il answer");
  expect(screen.getByRole("textbox", { name: "Reply text before quote 1" })).toHaveValue("IntroTa");
  fireEvent.click(screen.getByRole("button", { name: "Move quote 1" }), { detail: 0 });
  fireEvent.keyDown(tail, { key: "Escape" });
  fireEvent.keyDown(tail, { key: "Enter" });
  expect(tail).toHaveValue("il answer");
});

it("keeps the close control inside the square full-width quote surface", () => {
  render(<Composer />);
  const quote = screen.getByTestId("composer-reply-quote");
  expect(quote).toHaveClass("w-full", "rounded-none", "items-center");
  expect(quote.contains(screen.getByRole("button", { name: "Remove quote" }))).toBe(true);
});

it("undoes a quote move only while later authored edits remain untouched", () => {
  const { result } = renderHook(useReplyDraft);
  act(() => {
    result.current.replaceText("Intro");
  });
  act(() => {
    result.current.appendQuote("Quote");
  });
  act(() => {
    result.current.editText(null, "Tail");
  });
  const before = result.current.fullText;
  const id = result.current.draft.quotes[0]!.id;
  act(() => result.current.moveQuote(id, null, 2));
  act(() => result.current.editText(null, "Later edit"));
  expect(result.current.undoQuoteMove()).toBe(false);
  expect(result.current.draft.text).toBe("Later edit");
  act(() => result.current.editText(null, "il"));
  act(() => {
    expect(result.current.undoQuoteMove()).toBe(true);
  });
  expect(result.current.fullText).toBe(before);
  act(() => result.current.moveQuote(id, null, 1));
  act(() => result.current.replaceText("Different session"));
  expect(result.current.undoQuoteMove()).toBe(false);
});
