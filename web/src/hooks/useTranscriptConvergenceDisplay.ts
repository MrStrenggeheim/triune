// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
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
  const viewerScope = resourceViewStorageScope();
  const viewId = useRef<string | undefined>(undefined);
  const committed = useRef<
    {
      node: HTMLElement;
      itemId: string;
      position?: number;
      folded: boolean;
      identity: ReturnType<typeof readBlockConvergenceIdentity>;
    }[]
  >([]);
  const resample = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    const element = root.current;
    if (!visible || !element) return;
    viewId.current ??= crypto.randomUUID();
    const indexes = blocks ? transcriptIndex(blocks).items : undefined;
    const nodes = element.querySelectorAll<HTMLElement>(
      "[data-search-item-id], [data-user-message-id], [data-convergence-item-id], [data-convergence-members]",
    );
    committed.current = Array.from(nodes).flatMap((node) => {
      const id =
        node.dataset.convergenceItemId ?? node.dataset.searchItemId ?? node.dataset.userMessageId;
      let ids = id ? [id] : [];
      const folded =
        !id && !!node.dataset.convergenceMembers && node.getAttribute("aria-expanded") !== "true";
      if (folded) {
        try {
          const members: unknown = JSON.parse(node.dataset.convergenceMembers!);
          if (Array.isArray(members))
            ids = members.filter((member): member is string => typeof member === "string");
        } catch {
          /* Ignore incomplete markup. */
        }
      }
      return ids.map((itemId) => {
        const index = indexes?.get(itemId);
        const block = blocks && index !== undefined ? blocks[index] : undefined;
        return {
          node,
          itemId,
          folded,
          position: block?.ctx.position,
          identity: block ? readBlockConvergenceIdentity(block) : undefined,
        };
      });
    });
    resample.current?.();
  }, [root, conversationId, visible, contentVersion, viewport, blocks]);

  useEffect(() => {
    const element = root.current;
    if (!element || !conversationId || !visible) return;
    const scope = viewerScope;
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
        for (const { node, itemId, identity, position, folded } of committed.current) {
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
          recordTranscriptDisplayed(
            conversationId,
            {
              itemId,
              ...identity,
              position,
              viewId: viewId.current,
              ordinal: ids.size - 1,
              folded,
            },
            scope,
          );
          if (ids.size >= 64) break;
        }
      });
    };
    const schedule = () => {
      if (timer !== undefined || frame !== undefined) return;
      timer = setTimeout(sample, Math.max(0, 250 - (performance.now() - lastSample.current)));
    };
    resample.current = schedule;
    schedule();
    const scroller = viewport ?? element;
    scroller.addEventListener("scroll", schedule, { passive: true });
    document.addEventListener("visibilitychange", schedule);
    return () => {
      resample.current = undefined;
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [root, conversationId, visible, viewport, viewerScope]);
}
