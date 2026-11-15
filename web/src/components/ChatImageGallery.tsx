// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { isTempConvId } from "@/lib/tempConversationId";
import { loadChatGallery, type GalleryImage } from "./imageGallery";

export interface ChatGalleryScope {
  conversationId: string;
  load: (signal: AbortSignal) => Promise<GalleryImage[]>;
  imageSource?: string;
  imageItemId?: string | null;
}
const GalleryContext = createContext<ChatGalleryScope | null>(null);
export const useChatImageGallery = () => useContext(GalleryContext);

/** Put this inside the conversation's source scope, around transcript previews only. */
export function ChatImageGalleryProvider({
  conversationId,
  children,
  imageSource,
  imageItemId,
}: {
  conversationId: string | null | undefined;
  children: ReactNode;
  /** Explicit source for an image-only captured attachment dialog or dock preview. */
  imageSource?: string;
  imageItemId?: string | null;
}) {
  const value = useMemo<ChatGalleryScope | null>(
    () =>
      conversationId && !isTempConvId(conversationId)
        ? {
            conversationId,
            load: (signal) => loadChatGallery(conversationId, signal),
            imageSource,
            imageItemId,
          }
        : null,
    [conversationId, imageSource, imageItemId],
  );
  return <GalleryContext.Provider value={value}>{children}</GalleryContext.Provider>;
}
