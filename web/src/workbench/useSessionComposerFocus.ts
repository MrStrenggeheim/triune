// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useWorkbenchComposerFocus, type ComposerFocusRequest } from "./WorkbenchContext";

/** Explicit opens create a ticket; only the latest accepted ticket reaches a composer. */
export function useSessionComposerFocus(options: {
  scopeKey: string;
  active: boolean;
  href: string;
  focusedViewId?: string;
}) {
  const live = useRef(options);
  live.current = options;
  const serial = useRef(0);
  const pending = useRef<(ComposerFocusRequest & { source: string; accepted: boolean }) | null>(
    null,
  );
  const [request, setRequest] = useState<ComposerFocusRequest | null>(null);
  const cancel = useCallback(() => {
    pending.current = null;
    setRequest(null);
  }, []);
  const begin = useCallback((conversationId: string) => {
    const ticket = {
      id: ++serial.current,
      conversationId,
      viewId: `conversation:${conversationId}`,
      scopeKey: live.current.scopeKey,
      source: live.current.href,
      accepted: false,
    };
    pending.current = ticket;
    setRequest(null);
    return ticket;
  }, []);
  const accept = useCallback((ticket: ComposerFocusRequest | null) => {
    if (
      !ticket ||
      pending.current !== ticket ||
      !live.current.active ||
      ticket.scopeKey !== live.current.scopeKey
    )
      return;
    pending.current.accepted = true;
    setRequest(ticket);
  }, []);
  const acceptConversation = useCallback(
    (id: string) => {
      if (pending.current?.conversationId === id) accept(pending.current);
    },
    [accept],
  );
  const reject = useCallback(
    (ticket: ComposerFocusRequest | null) => {
      if (ticket && pending.current === ticket) cancel();
    },
    [cancel],
  );
  const hasPending = useCallback((id: string) => pending.current?.conversationId === id, []);
  const consume = useCallback(
    (id: number) => {
      if (pending.current?.id !== id) return false;
      cancel();
      return true;
    },
    [cancel],
  );
  useEffect(() => {
    const ticket = pending.current;
    if (!ticket) return;
    const destination = options.href.match(/^\/c\/([^/?#]+)/)?.[1];
    if (
      !options.active ||
      ticket.scopeKey !== options.scopeKey ||
      (ticket.accepted
        ? options.focusedViewId !== ticket.viewId
        : options.href !== ticket.source &&
          (!destination || decodeURIComponent(destination) !== ticket.conversationId))
    )
      cancel();
  }, [options.active, options.scopeKey, options.href, options.focusedViewId, request, cancel]);
  useEffect(() => {
    // Capture runs before the next explicit opener creates its replacement ticket.
    document.addEventListener("pointerdown", cancel, true);
    const onKeyDown = (event: KeyboardEvent) => {
      const editing =
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable=true]");
      if (
        editing ||
        event.key === "Tab" ||
        event.key === "Escape" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        cancel();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      pending.current = null;
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [cancel]);
  const value = useMemo(() => ({ request, consume }), [request, consume]);
  return { begin, accept, acceptConversation, reject, hasPending, cancel, value };
}

/** Terminal/read-only/error surfaces discard intent rather than saving it for a later mode change. */
export function useDiscardComposerFocus(
  conversationId: string | null | undefined,
  unavailable: boolean,
) {
  const focus = useWorkbenchComposerFocus();
  useEffect(() => {
    if (unavailable && focus?.request && focus.request.conversationId === conversationId)
      focus.consume(focus.request.id);
  }, [conversationId, unavailable, focus]);
}

/** Use the primary input after dialog dismissal; never restore drafts to obtain focus. */
export function useRequestedComposerFocus(
  conversationId: string | null | undefined,
  input: RefObject<HTMLTextAreaElement | null>,
  eligible: boolean,
) {
  const focus = useWorkbenchComposerFocus();
  useEffect(() => {
    const request = focus?.request;
    if (!request || request.conversationId !== conversationId) return;
    if (!eligible) {
      focus.consume(request.id);
      return;
    }
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const element = input.current;
        if (!focus.consume(request.id)) return;
        if (
          !element?.isConnected ||
          element.disabled ||
          element.readOnly ||
          element.closest("[inert]")
        )
          return;
        element.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [conversationId, input, eligible, focus]);
}
