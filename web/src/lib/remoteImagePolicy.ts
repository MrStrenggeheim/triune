// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

import { getBasePath } from "./basePath";

/** Exact remote assets supported by the renderer's GitHub-image opt-in. */
export function isAllowedRemoteImageSource(source: string): boolean {
  return /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    source,
  );
}

/** An exact authorized-file route; authorization still belongs to the source session and API. */
export function parseSessionFileSource(
  source: string,
  {
    origin = globalThis.location?.origin,
    basePath = getBasePath(),
  }: { origin?: string; basePath?: string } = {},
): { sessionId: string; fileId: string; path: string } | null {
  if (/[\\\s?#]/.test(source)) return null;
  let path = source;
  if (!path.startsWith("/")) {
    if (!origin || !/^https?:\/\//.test(source)) return null;
    try {
      const url = new URL(source);
      if (url.origin !== origin || url.username || url.password) return null;
      // Do not let URL parsing silently remove dot segments or rewrite input.
      if (source !== `${url.origin}${url.pathname}`) return null;
      path = url.pathname;
      if (basePath && !path.startsWith(`${basePath}/`)) return null;
    } catch {
      return null;
    }
  }
  if (basePath && path.startsWith(`${basePath}/`)) path = path.slice(basePath.length);
  const match = path.match(/^\/v1\/sessions\/([^/]+)\/resources\/files\/([^/]+)\/content$/);
  if (!match) return null;
  try {
    const [sessionId, fileId] = match.slice(1).map(decodeURIComponent);
    if (
      [sessionId, fileId].some(
        (id) =>
          /[/\\%\s]/.test(id) ||
          [...id].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
          id === "." ||
          id === "..",
      )
    )
      return null;
    if (encodeURIComponent(sessionId) !== match[1] || encodeURIComponent(fileId) !== match[2])
      return null;
    return {
      sessionId,
      fileId,
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/resources/files/${encodeURIComponent(fileId)}/content`,
    };
  } catch {
    return null;
  }
}

interface MarkdownImageNode {
  type: string;
  url?: string;
  children?: MarkdownImageNode[];
}

/** Normalize before image hardening, only for files scoped to this rendering session. */
export function canonicalSessionImages({ sessionId }: { sessionId: string | null }) {
  return (tree: MarkdownImageNode) => {
    function visit(node: MarkdownImageNode) {
      if ((node.type === "image" || node.type === "definition") && node.url) {
        const file = parseSessionFileSource(node.url);
        if (file && file.sessionId === sessionId) node.url = file.path;
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
