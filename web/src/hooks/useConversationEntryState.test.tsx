// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useShallow } from "zustand/react/shallow";
import { conversationRegistry } from "@/store/conversationRegistry";
import { useConversationEntryState } from "./useConversationEntryState";

afterEach(() => {
  cleanup();
  conversationRegistry.clear();
});

it("selects only the requested fields and follows the selected conversation", () => {
  const first = conversationRegistry.acquire("first");
  const second = conversationRegistry.acquire("second");
  second.setState({ sessionStatus: "running" });
  const renders = vi.fn();
  const { result, rerender } = renderHook(
    ({ id }) => {
      renders();
      return useConversationEntryState(
        id,
        useShallow((state) => ({ status: state.sessionStatus, blockedOn: state.blockedOn })),
      );
    },
    { initialProps: { id: "first" as string | null } },
  );
  const original = result.current;
  act(() => first.setState({ blocks: [] }));
  act(() => second.setState({ blockedOn: "permission prompt" }));
  expect(renders).toHaveBeenCalledOnce();
  expect(result.current).toBe(original);

  act(() => first.setState({ sessionStatus: "waiting" }));
  expect(renders).toHaveBeenCalledTimes(2);
  expect(result.current.status).toBe("waiting");
  rerender({ id: "second" });
  expect(result.current).toEqual({ status: "running", blockedOn: "permission prompt" });
  act(() => first.setState({ blockedOn: "ignored" }));
  expect(renders).toHaveBeenCalledTimes(3);
  act(() => conversationRegistry.release("second"));
  expect(result.current).toEqual({ status: "idle", blockedOn: null });
  rerender({ id: null });
  act(() => conversationRegistry.acquire("second").setState({ sessionStatus: "running" }));
  expect(result.current).toEqual({ status: "idle", blockedOn: null });
});

it("retains whole-entry reads and observes an initially absent entry", () => {
  const { result } = renderHook(() => useConversationEntryState("later"));
  const empty = result.current;
  act(() => conversationRegistry.acquire("later").setState({ sessionStatus: "running" }));
  expect(result.current.sessionStatus).toBe("running");
  act(() => conversationRegistry.peek("later")!.setState({ blocks: [] }));
  expect(result.current).toBe(conversationRegistry.peek("later")!.getState());
  act(() => conversationRegistry.release("later"));
  expect(result.current).toBe(empty);
});
