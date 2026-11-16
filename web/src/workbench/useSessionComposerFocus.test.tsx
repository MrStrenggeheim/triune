// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useRef, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchProvider, type ComposerFocusRequest } from "./WorkbenchContext";
import {
  useSessionComposerFocus,
  useRequestedComposerFocus,
  useDiscardComposerFocus,
} from "./useSessionComposerFocus";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const options = { active: true, scopeKey: "scope", href: "/c/a", focusedViewId: "conversation:a" };
it("requires explicit acceptance, gives retained/same-session opens fresh identities and consumes once", () => {
  const { result } = renderHook(() => useSessionComposerFocus(options));
  expect(result.current.value.request).toBeNull();
  let first!: ComposerFocusRequest;
  act(() => {
    first = result.current.begin("a");
  });
  expect(result.current.value.request).toBeNull();
  act(() => result.current.accept(first));
  expect(result.current.value.request).toBe(first);
  act(() => result.current.value.consume(first.id));
  expect(result.current.value.request).toBeNull();
  let next!: ComposerFocusRequest;
  act(() => {
    next = result.current.begin("a");
    result.current.accept(next);
  });
  expect(next.id).not.toBe(first.id);
  act(() => result.current.value.consume(first.id));
  expect(result.current.value.request).toBe(next);
});
it.each(["pointerdown", "keydown"] as const)(
  "cancels before/after acceptance on newer %s input",
  (event) => {
    const { result } = renderHook(() => useSessionComposerFocus(options));
    let ticket!: ComposerFocusRequest;
    act(() => {
      ticket = result.current.begin("a");
    });
    fireEvent(
      document.body,
      event === "keydown"
        ? new KeyboardEvent(event, { key: "Tab", bubbles: true })
        : new Event(event, { bubbles: true }),
    );
    act(() => result.current.accept(ticket));
    expect(result.current.value.request).toBeNull();
    act(() => {
      ticket = result.current.begin("a");
      result.current.accept(ticket);
    });
    fireEvent(
      document.body,
      event === "keydown"
        ? new KeyboardEvent(event, { key: "Tab", bubbles: true })
        : new Event(event, { bubbles: true }),
    );
    expect(result.current.value.request).toBeNull();
  },
);
it("ignores superseded tickets and cancels scope, route and deliberate view changes", () => {
  const { result, rerender } = renderHook(useSessionComposerFocus, { initialProps: options });
  let old!: ComposerFocusRequest;
  act(() => {
    old = result.current.begin("b");
    result.current.begin("a");
    result.current.accept(old);
  });
  expect(result.current.value.request).toBeNull();
  act(() => result.current.acceptConversation("a"));
  expect(result.current.value.request?.conversationId).toBe("a");
  rerender({ ...options, focusedViewId: "file:x" });
  expect(result.current.value.request).toBeNull();
  act(() => {
    old = result.current.begin("b");
  });
  rerender({ ...options, href: "/settings" });
  act(() => result.current.accept(old));
  expect(result.current.value.request).toBeNull();
  act(() => {
    old = result.current.begin("a");
  });
  rerender({ ...options, scopeKey: "other" });
  act(() => result.current.accept(old));
  expect(result.current.value.request).toBeNull();
});
it("defers an accepted ticket while its destination is loading without creating intent on refresh", () => {
  const { result, rerender } = renderHook(useSessionComposerFocus, { initialProps: options });
  let ticket!: ComposerFocusRequest;
  act(() => {
    ticket = result.current.begin("b");
  });
  rerender({ ...options, href: "/c/b?message=exact" });
  expect(result.current.value.request).toBeNull();
  rerender({ ...options, href: "/c/b?message=exact", focusedViewId: "conversation:b" });
  act(() => result.current.accept(ticket));
  expect(result.current.value.request).toBe(ticket);
  rerender({ ...options, href: "/c/b?message=exact", focusedViewId: "conversation:b" });
  expect(result.current.value.request).toBe(ticket);
});

const request: ComposerFocusRequest = {
  id: 1,
  conversationId: "a",
  viewId: "conversation:a",
  scopeKey: "scope",
};
function Target({
  eligible = true,
  unavailable = false,
}: {
  eligible?: boolean;
  unavailable?: boolean;
}) {
  const primary = useRef<HTMLTextAreaElement>(null);
  useDiscardComposerFocus("a", unavailable);
  useRequestedComposerFocus("a", primary, eligible);
  return (
    <>
      <textarea aria-label="quote" />
      <textarea ref={primary} aria-label="primary" defaultValue="keep draft" />
    </>
  );
}
function provider(
  value: ComposerFocusRequest | null,
  consume: (id: number) => boolean,
  children: ReactNode,
) {
  return (
    <WorkbenchProvider
      value={{
        openConversation: vi.fn(),
        openView: vi.fn(),
        composerFocus: { request: value, consume },
      }}
    >
      {children}
    </WorkbenchProvider>
  );
}
function frameQueue() {
  let serial = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++serial, callback);
    return serial;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return () =>
    act(() => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(0));
    });
}
it("focuses only the primary input after dismissal frames, preserving draft, caret and scroll options", () => {
  const frame = frameQueue();
  const consume = vi.fn(() => true);
  render(provider(request, consume, <Target />));
  const input = screen.getByLabelText("primary") as HTMLTextAreaElement;
  input.setSelectionRange(2, 5);
  const focus = vi.spyOn(input, "focus");
  screen.getByLabelText("quote").focus();
  frame();
  expect(input).not.toHaveFocus();
  frame();
  expect(input).toHaveFocus();
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  expect(input).toHaveValue("keep draft");
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  expect(consume).toHaveBeenCalledExactlyOnceWith(1);
});
it.each([false, true])(
  "discards unavailable/mobile/hidden intent rather than focusing on a later update (terminal=%s)",
  (unavailable) => {
    const frame = frameQueue();
    const consume = vi.fn(() => true);
    const { rerender } = render(
      provider(request, consume, <Target eligible={false} unavailable={unavailable} />),
    );
    expect(consume).toHaveBeenCalledWith(1);
    rerender(provider(null, consume, <Target />));
    frame();
    frame();
    expect(screen.getByLabelText("primary")).not.toHaveFocus();
  },
);
it("cancels scheduled focus when a new request/view replaces the destination or the target unmounts", () => {
  const frame = frameQueue();
  const consume = vi.fn(() => true);
  const { rerender, unmount } = render(provider(request, consume, <Target />));
  frame();
  rerender(provider({ ...request, id: 2, conversationId: "b" }, consume, <Target />));
  frame();
  expect(screen.getByLabelText("primary")).not.toHaveFocus();
  rerender(provider(request, consume, <Target />));
  frame();
  unmount();
  frame();
  expect(consume).not.toHaveBeenCalled();
});

it("does not focus when a newer action invalidated a scheduled request before React cleanup", () => {
  const frame = frameQueue();
  const consume = vi.fn(() => false);
  render(
    provider(
      { id: 1, conversationId: "a", viewId: "conversation:a", scopeKey: "scope" },
      consume,
      <Target />,
    ),
  );
  frame();
  frame();
  expect(screen.getByLabelText("primary")).not.toHaveFocus();
});
