// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { isTranscriptAtBottom, readChatScrollPreference } from "@/lib/chatScrollPreference";
import { useContext, useEffect, useLayoutEffect, useRef, type MouseEvent } from "react";
import {
  ConversationScrollLockContext,
  releaseConversationScrollLock,
} from "@/components/ai-elements/conversation";

const handled = new WeakSet<Event>();
const owners = new WeakMap<HTMLElement, () => void>();
const explicitOwners = new WeakMap<Element, object>();
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function claimTranscriptScrollOwner(root: Element): () => void {
  cancelTranscriptDisclosureAnchor(root);
  const token = {};
  explicitOwners.set(root, token);
  return () => {
    if (explicitOwners.get(root) === token) explicitOwners.delete(root);
  };
}

/** Automatic reader anchoring yields while a user disclosure or exact search owns the pane. */
export function hasTranscriptScrollOwner(root: Element): boolean {
  return explicitOwners.has(root) || (root instanceof HTMLElement && owners.has(root));
}

/** Explicit navigation replaces any short-lived disclosure scroll ownership. */
export function cancelTranscriptDisclosureAnchor(root: Element): void {
  let element: Element | null = root;
  while (element) {
    if (element instanceof HTMLElement) owners.get(element)?.();
    element = element.parentElement;
  }
}

/** User disclosure owns scroll until layout settles; automatic reveal never enters here. */
export function useTranscriptDisclosureAnchor() {
  const lock = useContext(ConversationScrollLockContext);
  const owner = useRef<{ correct: () => void; cancel: () => void } | null>(null);
  useLayoutEffect(() => owner.current?.correct());
  useEffect(() => () => owner.current?.cancel(), []);
  return (event: MouseEvent<HTMLElement>) => {
    if (handled.has(event.nativeEvent) || !(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLElement>(
      "button, [role=button], [data-transcript-disclosure-trigger]",
    );
    if (
      !trigger ||
      (!trigger.hasAttribute("aria-expanded") &&
        !trigger.hasAttribute("data-transcript-disclosure-trigger"))
    )
      return;
    if (trigger.hasAttribute("disabled") || trigger.dataset.searchRevealing !== undefined) return;
    handled.add(event.nativeEvent);
    owner.current?.cancel();
    let scroller = trigger.parentElement;
    while (scroller && !["auto", "scroll"].includes(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement;
    if (scroller && isTranscriptAtBottom(scroller) && readChatScrollPreference() === "follow")
      return;
    if (lock) {
      lock.stopScroll();
      lock.state.isAtBottom = false;
      lock.state.escapedFromLock = true;
    }
    if (!scroller) return;
    releaseConversationScrollLock(scroller);
    owners.get(scroller)?.();
    const element = scroller;
    const anchorTop = trigger.getBoundingClientRect().top;
    const previousAnchor = element.style.overflowAnchor;
    element.style.overflowAnchor = "none";
    let frame = 0;
    let active = true;
    const correct = () => {
      if (!active || !trigger.isConnected) return;
      const delta = trigger.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 0.5) element.scrollTop += delta;
    };
    const cancel = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      element.style.overflowAnchor = previousAnchor;
      for (const type of ["wheel", "touchstart", "pointerdown"])
        element.removeEventListener(type, interrupt);
      element.ownerDocument.removeEventListener("keydown", interrupt);
      if (owners.get(element) === cancel) owners.delete(element);
      if (owner.current?.cancel === cancel) owner.current = null;
    };
    const interrupt = (input: Event) => {
      if (input instanceof KeyboardEvent) {
        if (!SCROLL_KEYS.has(input.key)) return;
        if (
          input.target instanceof Element &&
          input.target.closest("input, textarea, [contenteditable=true]")
        )
          return;
      }
      cancel();
    };
    const tick = () => {
      correct();
      if (active) frame = requestAnimationFrame(tick);
    };
    const timer = window.setTimeout(cancel, 400);
    for (const type of ["wheel", "touchstart", "pointerdown"])
      element.addEventListener(type, interrupt, { passive: true });
    element.ownerDocument.addEventListener("keydown", interrupt);
    owners.set(element, cancel);
    owner.current = { correct, cancel };
    frame = requestAnimationFrame(tick);
  };
}
