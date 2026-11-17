// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { copyTextFieldTypography } from "./textFieldMirror";

export interface TextareaDropCaret {
  offset: number;
  left: number;
  top: number;
  height: number;
}

/** Ask the browser for the exact text offset using a layout-equivalent, temporary mirror. */
export function textareaDropCaret(
  textarea: HTMLTextAreaElement,
  point?: { x: number; y: number },
): TextareaDropCaret | null {
  const document = textarea.ownerDocument;
  const style = document.defaultView!.getComputedStyle(textarea);
  const bounds = textarea.getBoundingClientRect();
  const mirror = document.createElement("div");
  copyTextFieldTypography(mirror, style);
  Object.assign(mirror.style, {
    position: "fixed",
    left: `${bounds.left + textarea.clientLeft - textarea.scrollLeft}px`,
    top: `${bounds.top + textarea.clientTop - textarea.scrollTop}px`,
    boxSizing: "border-box",
    width: `${textarea.clientWidth}px`,
    minHeight: `${textarea.scrollHeight}px`,
    padding: style.padding,
    border: "0",
    opacity: "0",
    zIndex: "2147483647",
    whiteSpace: textarea.wrap === "off" ? "pre" : "pre-wrap",
    overflowWrap: "break-word",
  });
  const text = document.createTextNode(textarea.value || "\u200b");
  mirror.append(text);
  document.body.append(mirror);
  try {
    let offset = textarea.selectionStart;
    if (point) {
      const caretDocument = document as Document & {
        caretPositionFromPoint?: (
          x: number,
          y: number,
        ) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const position = caretDocument.caretPositionFromPoint?.(point.x, point.y);
      const range = position ? undefined : caretDocument.caretRangeFromPoint?.(point.x, point.y);
      const node = position?.offsetNode ?? range?.startContainer;
      if (node !== text) return null;
      offset = position?.offset ?? range?.startOffset ?? offset;
    }
    offset = Math.max(0, Math.min(offset, textarea.value.length));
    const range = document.createRange();
    range.setStart(text, offset);
    range.collapse(true);
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    range.insertNode(marker);
    const caret = marker.getBoundingClientRect();
    return {
      offset,
      left: caret.left,
      top: caret.top,
      height: caret.height || parseFloat(style.lineHeight) || 20,
    };
  } finally {
    mirror.remove();
  }
}
