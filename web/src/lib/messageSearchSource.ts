// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

/** Match the server index without changing ordinary Markdown rendering. */
export function messageSearchSource(content: readonly unknown[]): string {
  return content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string" &&
      part.text
        ? [part.text]
        : [],
    )
    .join(" ");
}
