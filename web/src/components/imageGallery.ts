// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ConversationItem } from "@/lib/conversationItems";
import { normalizeAttachmentContent, type ChatAttachmentContent } from "@/lib/chatAttachments";
import { fetchSessionItemsPage } from "@/lib/sessionsApi";
import { isAllowedRemoteImageSource } from "@/lib/remoteImagePolicy";

export interface GalleryImage {
  id: string;
  source: string;
  alt: string;
  filename?: string;
  itemId?: string | null;
  sessionId: string;
}

/** Same captured file/reference endpoints as ChatAttachment; never use the current workspace. */
export function galleryAttachmentSource(
  sessionId: string,
  attachment?: ChatAttachmentContent,
  reference?: string,
  itemId?: string | null,
): string | undefined {
  const file = normalizeAttachmentContent(attachment);
  if (file.error || file.file_id?.startsWith("pending:")) return undefined;
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}`;
  if (file.file_id) return `${base}/resources/files/${encodeURIComponent(file.file_id)}/content`;
  const inline = file.image_url ?? file.file_data;
  if (inline?.startsWith("data:image/")) return inline;
  if (inline && isAllowedRemoteImageSource(inline)) return inline;
  if (!reference) return undefined;
  if (reference.startsWith("data:image/")) return reference;
  if (isAllowedRemoteImageSource(reference)) return reference;
  let path = reference;
  if (/^file:/i.test(reference)) {
    try {
      const fileUrl = new URL(reference);
      if (fileUrl.hostname || fileUrl.search || fileUrl.hash) return undefined;
      path = decodeURIComponent(fileUrl.pathname);
      if (!path.startsWith("/") || path.startsWith("//") || path === "/" || /[?#]/.test(path))
        return undefined;
    } catch {
      return undefined;
    }
  }
  const stored = path.match(/^\/v1\/sessions\/([^/]+)\/resources\/files\/([^/]+)\/content$/);
  if (stored) return stored[1] === encodeURIComponent(sessionId) ? path : undefined;
  if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(path) || !itemId) return undefined;
  return `${base}/attachments/references/${encodeURIComponent(itemId)}?${new URLSearchParams({ path })}`;
}

export async function galleryImagesFromItems(
  sessionId: string,
  items: readonly ConversationItem[],
): Promise<GalleryImage[]> {
  // Reuse the installed Markdown lexer: it handles code fences, reference images and nested labels.
  const [{ MarkdownManager }, { splitWorkspaceFileCitation }] = await Promise.all([
    import("@tiptap/markdown"),
    import("./ai-elements/streamdown-security"),
  ]);
  const parser = new MarkdownManager({ extensions: [] }).instance;
  const images: GalleryImage[] = [];
  for (const item of items) {
    const raw = item as unknown as Record<string, unknown>;
    if (raw.is_meta === true) continue;
    const native =
      raw.type === "native_tool" && raw.item && typeof raw.item === "object"
        ? (raw.item as Record<string, unknown>)
        : raw;
    const content = Array.isArray(raw.content) ? raw.content : [];
    const attachments = Array.isArray(native.omnigent_attachments)
      ? native.omnigent_attachments
      : [];
    let ordinal = 0;
    const add = (source: string | undefined, alt: string, filename?: string) => {
      if (source)
        images.push({
          id: `${item.id}:${ordinal++}`,
          source,
          alt,
          filename,
          itemId: item.id,
          sessionId,
        });
    };
    for (const block of [...content, ...attachments]) {
      if (!block || typeof block !== "object") continue;
      const value = block as Record<string, unknown>;
      if (
        (value.type === "input_text" || value.type === "output_text") &&
        typeof value.text === "string"
      ) {
        if (!value.text.includes("![")) continue;
        parser.walkTokens(parser.lexer(value.text), (token) => {
          if (token.type === "image") {
            let reference = token.href;
            if (!/^(?:data:image\/|file:|https?:\/\/)/i.test(reference)) {
              if (/[?#]/.test(reference)) return;
              try {
                const decoded = decodeURIComponent(reference);
                if (!splitWorkspaceFileCitation(decoded).hasPosition) reference = decoded;
              } catch {
                /* A literal percent is a valid captured filename. */
              }
            }
            add(
              galleryAttachmentSource(sessionId, undefined, reference, item.id),
              token.text || token.href.split("/").at(-1) || "Image",
              token.href.startsWith("data:") ? undefined : token.href.split(/[\\/]/).at(-1),
            );
          }
        });
      } else {
        const file = normalizeAttachmentContent(value);
        if (
          file.type === "input_image" ||
          file.type === "output_image" ||
          /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(file.filename ?? "") ||
          (file.image_url ?? file.file_data)?.startsWith("data:image/")
        )
          add(
            galleryAttachmentSource(sessionId, file),
            file.filename || "Attached image",
            file.filename,
          );
      }
    }
  }
  return images;
}

/** Each request is bounded; scan the authorized cursor chain without mounting transcript rows. */
export async function loadChatGallery(
  sessionId: string,
  signal: AbortSignal,
): Promise<GalleryImage[]> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  const pages: ConversationItem[][] = [];
  for (;;) {
    signal.throwIfAborted();
    // Every cursor depends on the preceding page.
    // oxlint-disable-next-line no-await-in-loop
    const page = await fetchSessionItemsPage(sessionId, { olderThan: cursor, limit: 100, signal });
    signal.throwIfAborted();
    pages.unshift(page.items);
    if (!page.hasMore) break;
    const next = page.items[0]?.id;
    if (!next || seen.has(next)) throw new Error("Image history returned an invalid cursor.");
    seen.add(next);
    cursor = next;
  }
  return galleryImagesFromItems(sessionId, pages.flat());
}

export function gallerySwipe(
  dx: number,
  dy: number,
  zoom: number,
): "previous" | "next" | "dismiss" | null {
  if (zoom > 1) return null;
  if (Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy) * 1.5) return dx < 0 ? "next" : "previous";
  if (Math.abs(dy) >= 80 && Math.abs(dy) > Math.abs(dx) * 1.5) return "dismiss";
  return null;
}
