// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
export interface ArtifactReference {
  file_id: string;
  title?: string;
}

export type ArtifactMarkdownPart =
  | { kind: "markdown"; text: string; offset: number }
  | { kind: "artifact"; reference: ArtifactReference; offset: number };

export function parseArtifactReference(source: string): ArtifactReference | null {
  if (source.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== "file_id" && key !== "title")) return null;
    if (typeof item.file_id !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(item.file_id))
      return null;
    if (item.title !== undefined && (typeof item.title !== "string" || item.title.length > 256))
      return null;
    return {
      file_id: item.file_id,
      ...(typeof item.title === "string" ? { title: item.title } : {}),
    };
  } catch {
    return null;
  }
}

/** Only complete, top-level canonical fences execute; examples inside other fences remain code. */
export function splitArtifactMarkdown(text: string): ArtifactMarkdownPart[] {
  const parts: ArtifactMarkdownPart[] = [];
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((line) => line[0]);
  let markdownStart = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const opening = line[0].match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/);
    if (!opening || (opening[1][0] === "`" && opening[2].includes("`"))) continue;
    const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*\\r?\\n?$`);
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end][0])) end += 1;
    if (end === lines.length) break;
    const offset = line.index!;
    const bodyStart = offset + line[0].length;
    const reference =
      opening[2].trim() === "triune-artifact"
        ? parseArtifactReference(text.slice(bodyStart, lines[end].index))
        : null;
    if (reference) {
      if (offset > markdownStart)
        parts.push({
          kind: "markdown",
          text: text.slice(markdownStart, offset),
          offset: markdownStart,
        });
      parts.push({ kind: "artifact", reference, offset });
      markdownStart = lines[end].index! + lines[end][0].length;
    }
    index = end;
  }
  if (markdownStart < text.length || parts.length === 0)
    parts.push({ kind: "markdown", text: text.slice(markdownStart), offset: markdownStart });
  return parts;
}

export const ARTIFACT_STATE_BYTES = 16 * 1024;

export function serializeArtifactState(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized && new TextEncoder().encode(serialized).length <= ARTIFACT_STATE_BYTES
      ? serialized
      : null;
  } catch {
    return null;
  }
}
