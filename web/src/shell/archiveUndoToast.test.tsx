// Modified for Triune.
// Tests for the post-archive Undo toast. Contract: archives in quick succession
// merge into ONE toast whose count updates live, Undo unarchives the whole merged
// batch via undoArchiveConversations, and "View archived" navigates to Settings.
// The batch is module state, so it's reset between cases and leftover toasts are
// dismissed.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { toast, setNotificationCenterOpen } from "@/lib/notifications";
import { NotificationBell } from "@/components/NotificationCenter";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearOptimisticTitles, recordOptimisticTitle } from "@/lib/optimisticTitles";
import type * as SonnerModule from "@/lib/notifications";
import type { Conversation } from "@/hooks/useConversations";

const mocks = vi.hoisted(() => ({
  undoArchiveConversations: vi.fn(),
  // Durations passed to `toast()` in call order — lets a test assert the pill's
  // computed lifetime directly (deterministic) instead of racing sonner's own
  // close timer in the DOM.
  toastDurations: [] as number[],
}));

// archiveUndoToast only pulls undoArchiveConversations from this module; a
// partial mock keeps the toast logic isolated from cache/network behavior.
vi.mock("@/hooks/useConversations", () => ({
  undoArchiveConversations: mocks.undoArchiveConversations,
}));

// Wrap sonner's real module (so the <Toaster> still renders for the DOM-based
// tests) but record each `toast()` call's duration for the cap assertion. ESM
// exports can't be spied in place, so a pass-through mock is the clean seam.
vi.mock("@/lib/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof SonnerModule>();
  const wrapped = ((message: unknown, opts?: { duration?: number }) => {
    if (typeof opts?.duration === "number") mocks.toastDurations.push(opts.duration);
    return (actual.toast as (m: unknown, o?: unknown) => unknown)(message, opts);
  }) as typeof actual.toast;
  Object.assign(wrapped, actual.toast); // carry .dismiss/.message/etc.
  return { ...actual, toast: wrapped };
});

import { showArchiveUndoToast, resetArchiveUndoBatchForTests } from "./archiveUndoToast";
import { Toaster } from "@/components/ui/sonner";

const queryClient = new QueryClient();

/** Minimal chat rows with readable titles matching their ids. */
const conv = (id: string): Conversation => ({
  id,
  object: "conversation",
  title: id,
  created_at: 0,
  updated_at: 0,
  labels: {},
  permission_level: null,
});

const convs = (...ids: string[]) => ids.map(conv);

type NavigateFn = Parameters<typeof showArchiveUndoToast>[2];
let navigate: NavigateFn;

function mountToaster() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <NotificationBell />
      </TooltipProvider>
      <Toaster />
    </MemoryRouter>,
  );
}

const show = (ids: string[]) =>
  act(() => showArchiveUndoToast(queryClient, convs(...ids), navigate));

beforeEach(() => {
  // Start every test on REAL timers so a fake clock left installed (or
  // advanced) by a prior test in this file can't leak into this one — the
  // pill's lifetime math is Date.now()-based, so a carried-over fake clock
  // would corrupt the elapsed deltas and close the pill early.
  vi.useRealTimers();
  mocks.undoArchiveConversations.mockReset().mockResolvedValue(undefined);
  mocks.toastDurations.length = 0;
  resetArchiveUndoBatchForTests();
  clearOptimisticTitles();
  navigate = vi.fn() as unknown as NavigateFn;
  toast.dismiss();
  setNotificationCenterOpen(false);
});

afterEach(async () => {
  resetArchiveUndoBatchForTests();
  act(() => toast.dismiss());
  // Sonner queues removal callbacks during its exit animation.
  await waitFor(() => expect(document.querySelector("[data-notification-card]")).toBeNull());
  cleanup();
  vi.useRealTimers();
});

describe("showArchiveUndoToast", () => {
  it("does not extend the live undo deadline while its card is hovered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mountToaster();
    await show(["a"]);
    fireEvent.pointerEnter(screen.getByTestId("archive-undo-toast-item"));
    await act(() => vi.advanceTimersByTimeAsync(5100));
    expect(screen.queryByTestId("archive-undo-toast-item")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("retains a safe restore action after the live undo window expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mountToaster();
    await show(["old"]);
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await show(["new"]);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect(mocks.undoArchiveConversations).toHaveBeenLastCalledWith(queryClient, convs("old"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(mocks.undoArchiveConversations).toHaveBeenLastCalledWith(queryClient, convs("new"));
  });

  it("names the single archived chat", async () => {
    mountToaster();
    await show(["a"]);

    expect(await screen.findByText("Archived “a”")).toBeInTheDocument();
    // Never the literal "session(s)".
    expect(screen.queryByText(/session\(s\)/)).not.toBeInTheDocument();
  });

  it("retains the actual chat name in history after expiry and restores its captured target", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mountToaster();
    const original = { ...conv("named-chat-id"), title: "Investigate login retries" };
    act(() => showArchiveUndoToast(queryClient, [original], navigate));
    expect(screen.getByText("Archived “Investigate login retries”")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3100));
    await show(["a-later-chat"]);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("Archived “Investigate login retries”")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(mocks.undoArchiveConversations).toHaveBeenLastCalledWith(queryClient, [original]);
  });

  it.each([
    { title: null, labels: undefined, prompt: undefined, expected: "New session" },
    {
      title: null,
      labels: { "omnigent.wrapper": "codex-native-ui" },
      prompt: undefined,
      expected: "Codex",
    },
    {
      title: null,
      labels: undefined,
      prompt: "Prepare the rollout",
      expected: "Prepare the rollout",
    },
  ])(
    "uses the canonical title fallback: $expected",
    async ({ title, labels, prompt, expected }) => {
      mountToaster();
      const conversation: Conversation = { ...conv("untitled-chat"), title, labels: labels ?? {} };
      if (prompt) recordOptimisticTitle(conversation.id, prompt);
      act(() => showArchiveUndoToast(queryClient, [conversation], navigate));
      expect(screen.getByText(`Archived “${expected}”`)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(mocks.undoArchiveConversations).toHaveBeenLastCalledWith(queryClient, [conversation]);
    },
  );

  it("keeps the named batch summary after the Undo window expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mountToaster();
    await show(["Plan", "Review", "Ship", "Monitor"]);
    expect(screen.getByText("“Plan”, “Review” and 2 more")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3100));
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("Archived 4 chats")).toBeInTheDocument();
    expect(
      screen.getByText("“Plan”, “Review” and 2 more. Restore these chats to the sidebar."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(mocks.undoArchiveConversations).toHaveBeenLastCalledWith(
      queryClient,
      convs("Plan", "Review", "Ship", "Monitor"),
    );
  });

  it("uses plural copy and keeps one toast when archives merge", async () => {
    mountToaster();
    await show(["a"]);
    await show(["b", "c"]);

    // Still a single toast, now covering all three.
    const titles = await screen.findAllByText(/^Archived \d+ chats$/);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toHaveTextContent("Archived 3 chats");
    expect(screen.getByText("“a”, “b” and 1 more")).toBeInTheDocument();
  });

  it("de-dupes ids already in the batch", async () => {
    mountToaster();
    await show(["a"]);
    await show(["a", "b"]);

    expect(await screen.findByText("Archived 2 chats")).toBeInTheDocument();
    expect(screen.getByText("“a”, “b”")).toBeInTheDocument();
  });

  it("undoes the whole merged batch and dismisses the toast", async () => {
    mountToaster();
    await show(["a"]);
    await show(["b", "c"]);

    await screen.findByText("Archived 3 chats");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });

    expect(mocks.undoArchiveConversations).toHaveBeenCalledTimes(1);
    expect(mocks.undoArchiveConversations).toHaveBeenCalledWith(queryClient, convs("a", "b", "c"));
    // The toast dismisses on Undo (sonner animates it out, so wait for removal).
    await waitFor(() => expect(screen.queryByText(/^Archived/)).not.toBeInTheDocument());
  });

  it("starts a fresh batch after an Undo", async () => {
    mountToaster();
    await show(["a", "b"]);
    await screen.findByText("Archived 2 chats");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mocks.undoArchiveConversations).toHaveBeenLastCalledWith(queryClient, convs("a", "b"));
    // Let the dismissed toast finish animating out before reusing the toast id.
    await waitFor(() => expect(screen.queryByText(/^Archived/)).not.toBeInTheDocument());

    // A later archive is its own batch, not appended to the undone one: it reads
    // "1 session" and undoing again restores only the new id.
    await show(["x"]);
    await screen.findByText("Archived “x”");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mocks.undoArchiveConversations).toHaveBeenLastCalledWith(queryClient, convs("x"));
  });

  it("navigates to the archived-sessions settings page via View archived", async () => {
    mountToaster();
    await show(["a"]);

    await screen.findByText("Archived “a”");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View archived" }));
    });
    expect(navigate).toHaveBeenCalledWith("/settings/archived");
  });

  it("bounds the merged pill by an absolute deadline instead of resetting it", async () => {
    // Regression: batched sidebar cleanup. Merges must NOT reset a fresh 3s
    // countdown — the batch's life is bounded from the first archive (5s cap,
    // below the 8s server grace), so the pill can't linger past the earliest
    // session's teardown and offer an Undo for an already-stopped runner.
    //
    // Assert on the `duration` this module passes to sonner, not on the pill's
    // DOM close time: whether sonner restarts its own timer when a toast is
    // updated in place is an implementation detail (and races under fake
    // timers), while the shrinking `duration` is exactly what we control.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      await show(["a"]); // t=0
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await show(["b"]); // t=2s
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await show(["c"]); // t=4s

      // First archive gets the full single-archive duration; merges shrink
      // toward the 5s absolute deadline and never reset to a fresh 3s:
      //   t=0 → min(3000, 5000-0)    = 3000
      //   t=2 → min(3000, 5000-2000) = 3000
      //   t=4 → min(3000, 5000-4000) = 1000  (closes at t=5s, not t=4+3=7s)
      expect(mocks.toastDurations).toEqual([3000, 3000, 1000]);
    } finally {
      resetArchiveUndoBatchForTests();
      toast.dismiss();
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      vi.useRealTimers();
    }
  });

  it("starts a fresh batch for an archive after the deadline", async () => {
    // An archive arriving past the deadline must not resurrect the old batch's
    // pill; it begins its own window.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      mountToaster();
      await show(["old"]);
      // Advance past the 5s deadline so the old batch is finished.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      await show(["new"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Archived “new”")).toBeInTheDocument();
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      // Only the fresh id, never the expired "old".
      expect(mocks.undoArchiveConversations).toHaveBeenLastCalledWith(queryClient, convs("new"));
    } finally {
      resetArchiveUndoBatchForTests();
      toast.dismiss();
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      vi.useRealTimers();
    }
  });
});
