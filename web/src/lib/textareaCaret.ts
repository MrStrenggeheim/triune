// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

import { copyTextFieldTypography } from "./textFieldMirror";

/** Content coordinates, including padding, with a marker on empty/trailing lines. */
export function textareaCaretRect(textarea: HTMLTextAreaElement) {
  const document = textarea.ownerDocument;
  const style = document.defaultView!.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  copyTextFieldTypography(mirror, style);
  Object.assign(mirror.style, {
    position: "fixed",
    top: "0",
    left: "0",
    boxSizing: "border-box",
    width: `${textarea.clientWidth}px`,
    padding: style.padding,
    border: "0",
    visibility: "hidden",
    pointerEvents: "none",
    whiteSpace: textarea.wrap === "off" ? "pre" : "pre-wrap",
    overflowWrap: "break-word",
  });
  const caret =
    textarea.selectionDirection === "backward" ? textarea.selectionStart : textarea.selectionEnd;
  mirror.textContent = textarea.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker, document.createTextNode(textarea.value.slice(caret)));
  document.body.append(mirror);
  try {
    const top = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
    const height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    return { top, bottom: top + height };
  } finally {
    mirror.remove();
  }
}

/** Scroll only the edited field and its explicit quote-area owner. */
export function revealTextareaCaret(textarea: HTMLTextAreaElement) {
  if (
    textarea.ownerDocument.activeElement !== textarea ||
    !textarea.clientHeight ||
    !textarea.clientWidth
  )
    return;
  const caret = textareaCaretRect(textarea);
  const delta = (top: number, bottom: number, height: number) =>
    top < 0 ? top : Math.max(0, bottom - height);
  const area = textarea.closest<HTMLElement>("[data-composer-input-area]");
  if (
    area &&
    textarea.ownerDocument.defaultView!.getComputedStyle(textarea).overflowY === "hidden"
  ) {
    // Unbounded quote fields can temporarily retain their old flex height.
    // Their area must reveal the caret without a field scroll that layout clears.
    textarea.scrollTop = 0;
  } else {
    textarea.scrollTop += delta(
      caret.top - textarea.scrollTop,
      caret.bottom - textarea.scrollTop,
      textarea.clientHeight,
    );
  }
  if (!area || area.scrollHeight <= area.clientHeight) return;
  const top =
    textarea.getBoundingClientRect().top +
    textarea.clientTop +
    caret.top -
    textarea.scrollTop -
    area.getBoundingClientRect().top -
    area.clientTop;
  area.scrollTop += delta(top, top + caret.bottom - caret.top, area.clientHeight);
}
