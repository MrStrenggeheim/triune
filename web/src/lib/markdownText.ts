// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
const MAX_MARKDOWN_TEXT_LENGTH = 50_000;
const MAX_UNBROKEN_TOKEN_LENGTH = 5_000;

/**
 * Longest run of consecutive non-whitespace characters in `text`. ASCII
 * whitespace (space, tab, CR, LF, FF, VT) resets the run — those are the
 * break opportunities the layout engine can use. O(n), single pass.
 */
function longestUnbrokenRun(text: string): number {
  let max = 0;
  let current = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // 32 = space; 9..13 = tab, LF, VT, FF, CR.
    if (code === 32 || (code >= 9 && code <= 13)) {
      current = 0;
    } else {
      current += 1;
      if (current > max) max = current;
    }
  }
  return max;
}

/**
 * Whether `text` should bypass the markdown pipeline because rendering it
 * there would risk locking the tab. See the constants above for the why.
 */
export function isPathologicalMarkdownText(text: string): boolean {
  return (
    text.length > MAX_MARKDOWN_TEXT_LENGTH || longestUnbrokenRun(text) > MAX_UNBROKEN_TOKEN_LENGTH
  );
}
