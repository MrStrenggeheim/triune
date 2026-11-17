// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useRef, type RefObject } from "react";
import {
  readBlockConvergenceIdentity,
  recordTranscriptDisplayed,
} from "@/lib/convergenceDiagnostics";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import { transcriptIndex } from "@/lib/transcriptOrder";
import type { AnyBlock } from "@/lib/blocks";

/** Sample committed, on-screen identities; a store publication alone is not display proof. */
export function useTranscriptConvergenceDisplay(
  root: RefObject<HTMLElement | null>,
  conversationId: string | null | undefined,
  visible: boolean,
  contentVersion: unknown,
  viewport?: HTMLElement | null,
  blocks?: AnyBlock[],
): void {
  const lastSample = useRef(0);
  useEffect(() => {
    const element = root.current;
    if (!element || !conversationId || !visible) return;
    const scope = resourceViewStorageScope();
    const indexes = blocks ? transcriptIndex(blocks).items : undefined;
    const mounted = Array.from(
      element.querySelectorAll<HTMLElement>("[data-search-item-id], [data-user-message-id]"),
    ).map((node) => {
      const itemId = node.dataset.searchItemId ?? node.dataset.userMessageId;
      const index = itemId ? indexes?.get(itemId) : undefined;
      return {
        node,
        itemId,
        identity:
          blocks && index !== undefined ? readBlockConvergenceIdentity(blocks[index]) : undefined,
      };
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    const sample = () => {
      timer = undefined;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (
          !element.isConnected ||
          document.visibilityState === "hidden" ||
          element.closest("[hidden], [inert]") ||
          scope !== resourceViewStorageScope()
        )
          return;
        const bounds = (viewport ?? element).getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        lastSample.current = performance.now();
        const ids = new Set<string>();
        for (const { node, itemId, identity } of mounted) {
          if (!node.isConnected || !itemId || ids.has(itemId)) continue;
          const box = node.getBoundingClientRect();
          if (
            box.width <= 0 ||
            box.height <= 0 ||
            box.bottom <= Math.max(0, bounds.top) ||
            box.top >= Math.min(window.innerHeight, bounds.bottom) ||
            box.right <= Math.max(0, bounds.left) ||
            box.left >= Math.min(window.innerWidth, bounds.right) ||
            node.closest("[hidden], [inert]")
          )
            continue;
          ids.add(itemId);
          recordTranscriptDisplayed(conversationId, { itemId, ...identity }, scope);
          if (ids.size >= 64) break;
        }
      });
    };
    const schedule = () => {
      if (timer !== undefined || frame !== undefined) return;
      timer = setTimeout(sample, Math.max(0, 250 - (performance.now() - lastSample.current)));
    };
    schedule();
    const scroller = viewport ?? element;
    scroller.addEventListener("scroll", schedule, { passive: true });
    document.addEventListener("visibilitychange", schedule);
    return () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [root, conversationId, visible, contentVersion, viewport, blocks]);
}
