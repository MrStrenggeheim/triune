// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

/** Match text metrics for caret mirrors without changing the live input. */
export function copyTextFieldTypography(target: HTMLElement, style: CSSStyleDeclaration) {
  target.style.font = style.font;
  target.style.letterSpacing = style.letterSpacing;
  target.style.wordSpacing = style.wordSpacing;
  target.style.textTransform = style.textTransform;
  target.style.textIndent = style.textIndent;
  target.style.tabSize = style.tabSize;
  target.style.direction = style.direction;
}
