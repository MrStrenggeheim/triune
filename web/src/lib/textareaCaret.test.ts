import { afterEach, expect, it, vi } from "vitest";
import { revealTextareaCaret, textareaCaretRect } from "./textareaCaret";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function field(caretTop: number) {
  const transcript = document.createElement("div");
  const area = document.createElement("div");
  area.dataset.composerInputArea = "";
  const textarea = document.createElement("textarea");
  textarea.style.lineHeight = "20px";
  textarea.style.fontSize = "14px";
  textarea.value = "line\n";
  textarea.setSelectionRange(5, 5);
  area.append(textarea);
  transcript.append(area);
  document.body.append(transcript);
  Object.defineProperties(textarea, {
    clientHeight: { value: 100, configurable: true },
    clientWidth: { value: 200 },
    scrollHeight: { value: 400 },
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return new DOMRect(
      0,
      this.tagName === "SPAN" ? caretTop : this === textarea ? 100 : this === area ? 50 : 0,
      200,
      20,
    );
  });
  textarea.focus();
  transcript.scrollTop = 75;
  return { textarea, area, transcript };
}

it("measures a true marker after a trailing newline and removes the mirror", () => {
  const { textarea } = field(120);
  expect(textareaCaretRect(textarea)).toEqual({ top: 120, bottom: 140 });
  expect(document.querySelector('[style*="visibility: hidden"]')).toBeNull();
  expect(textarea.selectionStart).toBe(5);
});

it.each([
  [120, 0, 40],
  [20, 60, 20],
  [40, 20, 20],
])("minimally reveals the caret at %s from offset %s", (caretTop, previous, expected) => {
  const { textarea, transcript } = field(caretTop);
  textarea.scrollTop = previous;
  revealTextareaCaret(textarea);
  expect(textarea.scrollTop).toBe(expected);
  expect(transcript.scrollTop).toBe(75);
  expect(textarea.value).toBe("line\n");
  expect(textarea.selectionEnd).toBe(5);
});

it("reveals quoted text only inside the local input area", () => {
  const { textarea, area, transcript } = field(80);
  textarea.style.overflowY = "hidden";
  Object.defineProperties(textarea, { clientHeight: { value: 400, configurable: true } });
  Object.defineProperties(area, {
    clientHeight: { value: 100, configurable: true },
    scrollHeight: { value: 500 },
  });
  revealTextareaCaret(textarea);
  expect(area.scrollTop).toBe(50);
  expect(transcript.scrollTop).toBe(75);
});

it("uses the quote area while an unbounded field still has its old flex height", () => {
  const { textarea, area, transcript } = field(120);
  textarea.style.overflowY = "hidden";
  textarea.scrollTop = 22;
  Object.defineProperties(area, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 500 },
  });
  revealTextareaCaret(textarea);
  expect(textarea.scrollTop).toBe(0);
  expect(area.scrollTop).toBe(90);
  expect(transcript.scrollTop).toBe(75);
  expect(textarea.value).toBe("line\n");
  expect(textarea.selectionEnd).toBe(5);
  expect(document.activeElement).toBe(textarea);
});

it("does not reveal a background draft", () => {
  const { textarea } = field(120);
  textarea.blur();
  revealTextareaCaret(textarea);
  expect(textarea.scrollTop).toBe(0);
});
