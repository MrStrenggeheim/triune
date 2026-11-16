import { useShortcutHandlers } from "@/lib/shortcutDispatcher";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ComposerConfigChoice } from "@/components/composer/ComposerConfigSections";
import { isImeCompositionKeyEvent } from "@/lib/ime";

/** Ctrl+Alt+M/E cycles the same model/effort choices offered by the composer menu. */
export function useComposerConfigCycleHotkeys(
  models: readonly ComposerConfigChoice[] | undefined,
  efforts: readonly ComposerConfigChoice[] | undefined,
  enabled = true,
  pending = false,
  deferred?: { apply: () => void; cancel: () => void },
): { preview: "models" | "efforts" | null; dismissPreview: () => void } {
  const latest = useRef({ models, efforts });
  latest.current = { models, efforts };
  const deferredRef = useRef(deferred);
  deferredRef.current = deferred;
  const hasDeferred = deferred !== undefined;
  const [previewRequest, setPreviewRequest] = useState<{ section: "models" | "efforts" } | null>(
    null,
  );
  const preview = previewRequest?.section ?? null;
  const checkedKey = (preview === "models" ? models : efforts)?.find(
    (choice) => choice.checked,
  )?.key;
  const dismissPreview = useCallback(() => {
    deferredRef.current?.cancel();
    setPreviewRequest(null);
  }, []);

  useEffect(() => {
    if (!previewRequest || pending) return;
    const timeout = window.setTimeout(() => {
      if (deferredRef.current) deferredRef.current.apply();
      else dismissPreview();
    }, 2_000);
    return () => window.clearTimeout(timeout);
  }, [previewRequest, checkedKey, dismissPreview, pending]);

  useEffect(() => {
    if (!previewRequest || !hasDeferred) return;
    const confirm = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Enter" ||
        event.defaultPrevented ||
        event.shiftKey ||
        event.altKey ||
        isImeCompositionKeyEvent({ nativeEvent: event }) ||
        !(event.target instanceof Element) ||
        !event.target.closest("[data-composer-card] textarea, [data-cycle-preview]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) deferredRef.current?.apply();
    };
    document.addEventListener("keydown", confirm, true);
    return () => document.removeEventListener("keydown", confirm, true);
  }, [previewRequest, hasDeferred]);

  function cycle(section: "models" | "efforts") {
    const choices = latest.current[section];
    if (!choices?.length) return false;
    const current = choices.findIndex((choice) => choice.checked);
    for (let offset = 1; offset <= choices.length; offset++) {
      const next = choices[(current + offset) % choices.length];
      if (!next.disabled && !next.checked && next.onSelect) {
        next.onSelect();
        setPreviewRequest({ section });
        return;
      }
    }
    return false;
  }
  useShortcutHandlers(
    { "cycle-model": () => cycle("models"), "cycle-effort": () => cycle("efforts") },
    enabled,
  );
  return { preview, dismissPreview };
}
