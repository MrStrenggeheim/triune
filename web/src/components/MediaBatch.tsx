// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { createContext, useContext, type ReactNode } from "react";
import { normalizeAttachmentContent } from "@/lib/chatAttachments";
import { IMAGE_PREVIEW_MAX_HEIGHT } from "./ImageLightbox";

const MediaBatchContext = createContext(false);
export const useMediaBatch = () => useContext(MediaBatchContext);

/** A batch has one media height; overflowing proportions scroll without wrapping. */
export function MediaBatch({ children }: { children: ReactNode }) {
  return (
    <MediaBatchContext.Provider value={true}>
      <div
        data-media-batch
        className="not-prose my-2 flex min-w-0 max-w-full flex-nowrap items-start gap-2 overflow-x-auto"
        role="group"
        aria-label="Media previews"
      >
        {children}
      </div>
    </MediaBatchContext.Provider>
  );
}

export function isVisualAttachment(value: unknown): boolean {
  const attachment = normalizeAttachmentContent(value);
  return (
    !attachment.error &&
    (["image", "image_url", "input_image"].includes(attachment.type ?? "") ||
      /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|mp4|webm|mov|m4v|ogv)$/i.test(
        attachment.filename ?? "",
      ) ||
      /^data:(image|video)\//.test(attachment.image_url ?? attachment.file_data ?? ""))
  );
}

/** Group consecutive visual entries without moving any intervening content. */
export function groupAdjacentMedia<T>(items: readonly T[], isVisual: (item: T) => boolean): T[][] {
  const groups: T[][] = [];
  let visual = false;
  for (const item of items) {
    const nextVisual = isVisual(item);
    if (nextVisual && visual) groups[groups.length - 1].push(item);
    else groups.push([item]);
    visual = nextVisual;
  }
  return groups;
}

/** Keep tiny images at natural pixels inside a proportioned 256px batch slot. */
export function mediaPreviewSize(
  size: { width: number; height: number } | undefined,
  batched: boolean,
) {
  if (!size || !batched) return size;
  return {
    width: (size.width / size.height) * IMAGE_PREVIEW_MAX_HEIGHT,
    height: IMAGE_PREVIEW_MAX_HEIGHT,
  };
}

/** Render existing attachment components unchanged; do not flatten across messages or text. */
export function MediaBatchItems<T>({
  items,
  renderItem,
  isVisual = isVisualAttachment,
}: {
  items: readonly T[];
  renderItem: (item: T, index: number) => ReactNode;
  isVisual?: (item: T) => boolean;
}) {
  let index = 0;
  return groupAdjacentMedia(items, isVisual).map((group) => {
    const start = index;
    const children = group.map((item) => renderItem(item, index++));
    return group.length > 1 && isVisual(group[0]) ? (
      <MediaBatch key={start}>{children}</MediaBatch>
    ) : (
      <span key={start} className="contents">
        {children}
      </span>
    );
  });
}

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  value?: string;
}

/** Blank lines between adjacent preview-only paragraphs do not split a media run. */
export function remarkMediaBatches() {
  return (tree: MarkdownNode) => {
    const imageOnly = (node: MarkdownNode) =>
      node.type === "paragraph" &&
      !!node.children?.some((child) => child.type === "image" || child.type === "imageReference") &&
      node.children.every(
        (child) =>
          child.type === "image" ||
          child.type === "imageReference" ||
          (child.type === "text" && !child.value?.trim()),
      );
    const children: MarkdownNode[] = [];
    for (const node of tree.children ?? []) {
      const previous = children.at(-1);
      if (previous && imageOnly(previous) && imageOnly(node))
        previous.children!.push({ type: "text", value: " " }, ...node.children!);
      else children.push(node);
    }
    tree.children = children;
  };
}
