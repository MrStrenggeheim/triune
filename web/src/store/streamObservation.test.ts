// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, expect, it, vi } from "vitest";
import {
  observeConversationStream,
  STREAM_SNAPSHOT_INTERVAL_MS,
  STREAM_SNAPSHOT_TIMEOUT_MS,
  refreshConversationObservationPriority,
} from "./streamObservation";
import { getStreamSlotManager, resetStreamSlotManager } from "./streamSlots";

const controllers: AbortController[] = [];
afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.abort());
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetStreamSlotManager();
});

function browserPage() {
  const page = new EventTarget();
  const browser = new EventTarget();
  let visibility = "visible";
  Object.defineProperties(page, {
    visibilityState: { get: () => visibility },
    hasFocus: { value: () => true },
  });
  return {
    document: page as Document,
    window: browser as Window,
    show: (visible: boolean) => {
      visibility = visible ? "visible" : "hidden";
      page.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

function observe(
  page: ReturnType<typeof browserPage>,
  acquire: Parameters<typeof observeConversationStream>[0]["acquire"],
  priority = () => 1,
  catchUp = vi.fn(async (_signal: AbortSignal) => {}),
  multiplexed = false,
) {
  const binding = new AbortController();
  controllers.push(binding);
  const pump = vi.fn(
    (controller: AbortController, _resumed: boolean) =>
      new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  const done = observeConversationStream({
    ...page,
    signal: binding.signal,
    acquire,
    pump,
    catchUp,
    priority,
    multiplexed: () => multiplexed,
  });
  return { binding, catchUp, pump, done };
}

it("keeps visible multiplex memberships through blur and priority contention, suspending only on hide", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { locks: {} });
  const page = browserPage();
  const multiplex = observe(page, oneSlot(), () => 1, vi.fn(), true);
  await vi.advanceTimersByTimeAsync(0);
  page.window.dispatchEvent(new Event("blur"));
  const legacy = observe(
    page,
    vi.fn(async () => null),
    () => 2,
  );
  refreshConversationObservationPriority();
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS * 2);
  expect(multiplex.pump).toHaveBeenCalledTimes(1);
  expect(multiplex.pump.mock.calls[0][0].signal.aborted).toBe(false);
  expect(multiplex.catchUp).not.toHaveBeenCalled();
  page.show(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(multiplex.pump.mock.calls[0][0].signal.aborted).toBe(true);
  page.show(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(multiplex.pump).toHaveBeenCalledTimes(2);
  multiplex.binding.abort();
  legacy.binding.abort();
  await Promise.all([multiplex.done, legacy.done]);
});

function oneSlot() {
  let held = false;
  return vi.fn(async () => {
    if (held) return null;
    held = true;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        held = false;
      },
    };
  });
}

it("yields the actual Web Lock to another browser window on hide and reconciles on return", async () => {
  vi.useFakeTimers();
  const held = new Set<string>();
  const locks = {
    request: async (
      name: string,
      _options: unknown,
      callback: (lock: object | null) => Promise<void>,
    ) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  vi.stubGlobal("navigator", { locks });
  resetStreamSlotManager();
  const manager = getStreamSlotManager();
  const first = browserPage();
  const second = browserPage();
  second.show(false);
  const a = observe(first, manager.tryAcquire);
  await vi.advanceTimersByTimeAsync(0);
  const heldName = [...held][0]!;
  // Fill the other slots as if other origin clients hold them.
  const remaining = [await manager.tryAcquire(), await manager.tryAcquire()];
  const b = observe(second, manager.tryAcquire);
  await vi.advanceTimersByTimeAsync(0);
  expect(a.pump).toHaveBeenCalledTimes(1);
  expect(b.pump).not.toHaveBeenCalled();
  first.show(false);
  second.show(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.pump.mock.calls[0]![0].signal.aborted).toBe(true);
  expect(b.pump).toHaveBeenCalledTimes(1);
  expect(held.has(heldName)).toBe(true);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(a.catchUp).not.toHaveBeenCalled();
  second.show(false);
  first.show(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.pump).toHaveBeenCalledTimes(2);
  expect(a.pump.mock.calls[1]![1]).toBe(true);
  a.binding.abort();
  b.binding.abort();
  await Promise.all([a.done, b.done]);
  await Promise.all(remaining.map((slot) => slot?.release()));
  expect(held.size).toBe(0);
});

it("keeps every excess visible pane current through serialized bounded snapshots", async () => {
  vi.useFakeTimers();
  const page = browserPage();
  const acquire = oneSlot();
  const panes = Array.from({ length: 8 }, () => observe(page, acquire));
  await vi.advanceTimersByTimeAsync(0);
  expect(panes.flatMap((pane) => pane.pump.mock.calls)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS * 3);
  for (const pane of panes.slice(1)) expect(pane.catchUp).toHaveBeenCalledTimes(3);
  page.show(false);
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS * 2);
  for (const pane of panes.slice(1)) expect(pane.catchUp).toHaveBeenCalledTimes(3);
});

it("gives the focused pane a lower-priority stream and keeps the yielded pane catching up", async () => {
  vi.useFakeTimers();
  const page = browserPage();
  const acquire = oneSlot();
  let focused = "a";
  const a = observe(page, acquire, () => (focused === "a" ? 2 : 1));
  await vi.advanceTimersByTimeAsync(0);
  const b = observe(page, acquire, () => (focused === "b" ? 2 : 1));
  await vi.advanceTimersByTimeAsync(0);
  focused = "b";
  refreshConversationObservationPriority();
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.pump.mock.calls[0]![0].signal.aborted).toBe(true);
  expect(b.pump).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
  expect(a.catchUp).toHaveBeenCalled();
  page.window.dispatchEvent(new Event("blur"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(b.pump.mock.calls[0]![0].signal.aborted).toBe(true);
  page.window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(b.pump).toHaveBeenCalledTimes(2);
});

it("limits snapshot work to two jobs and gives every queued visible pane a turn", async () => {
  vi.useFakeTimers();
  const page = browserPage();
  const finish: (() => void)[] = [];
  const started: number[] = [];
  let running = 0;
  let peak = 0;
  for (let id = 0; id < 8; id++) {
    const binding = new AbortController();
    controllers.push(binding);
    void observeConversationStream({
      ...page,
      signal: binding.signal,
      acquire: async () => null,
      pump: async () => {},
      catchUp: () =>
        new Promise<void>((resolve) => {
          started.push(id);
          running++;
          peak = Math.max(peak, running);
          finish.push(() => {
            running--;
            resolve();
          });
        }),
    });
  }
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
  expect(started).toHaveLength(2);
  for (let index = 0; index < 8; index++) {
    finish.shift()!();
    // eslint-disable-next-line no-await-in-loop -- Each completion admits the next waiter.
    await vi.advanceTimersByTimeAsync(0);
  }
  expect([...started].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(peak).toBe(2);
});

it("preempts a pending fallback on focus without waiting for its resolution", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { locks: {} });
  const page = browserPage();
  let finish!: () => void;
  const catchUp = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pane = observe(page, oneSlot(), () => 1, catchUp);
  await vi.advanceTimersByTimeAsync(0);
  page.window.dispatchEvent(new Event("blur"));
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
  expect(catchUp).toHaveBeenCalledTimes(1);
  const snapshotSignal = catchUp.mock.calls[0]![0];
  page.window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(snapshotSignal.aborted).toBe(true);
  expect(pane.pump).toHaveBeenCalledTimes(2);
  finish();
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
  expect(pane.pump).toHaveBeenCalledTimes(2);
  expect(pane.pump.mock.calls[1]![0].signal.aborted).toBe(false);
  pane.binding.abort();
  await pane.done;
});

it.each(["focus", "hide", "dispose"] as const)(
  "cancels queued fallback on %s without overadmitting unfinished work",
  async (action) => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: {} });
    const finish: (() => void)[] = [];
    const panes = Array.from({ length: 3 }, () => {
      const page = browserPage();
      const catchUp = vi.fn(
        (_signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            finish.push(resolve);
          }),
      );
      return { page, ...observe(page, oneSlot(), () => 1, catchUp) };
    });
    await vi.advanceTimersByTimeAsync(0);
    for (const pane of panes) pane.page.window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
    expect(finish).toHaveLength(2);
    if (action === "focus") panes[2]!.page.window.dispatchEvent(new Event("focus"));
    else if (action === "hide") panes[2]!.page.show(false);
    else panes[2]!.binding.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(panes[2]!.pump).toHaveBeenCalledTimes(action === "focus" ? 2 : 1);
    expect(panes[2]!.catchUp).not.toHaveBeenCalled();
    for (const pane of panes) pane.binding.abort();
    await Promise.all(panes.map((pane) => pane.done));

    const nextPage = browserPage();
    const next = observe(nextPage, async () => null);
    await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
    expect(next.catchUp).not.toHaveBeenCalled();
    finish.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(next.catchUp).toHaveBeenCalledTimes(1);
    finish.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    next.binding.abort();
    await next.done;
    expect(panes[2]!.catchUp).not.toHaveBeenCalled();
  },
);

it("aborts timed-out snapshot IO and retries observation with a fresh signal", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const catchUp = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  );
  const acquire = vi.fn(async () => null);
  const pane = observe(browserPage(), acquire, () => 1, catchUp);
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
  const firstSignal = catchUp.mock.calls[0]![0];
  const acquisitions = acquire.mock.calls.length;
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_TIMEOUT_MS);
  expect(firstSignal.aborted).toBe(true);
  expect(acquire.mock.calls.length).toBeGreaterThan(acquisitions);
  expect(catchUp).toHaveBeenCalledTimes(2);
  expect(catchUp.mock.calls[1]![0]).not.toBe(firstSignal);
  expect(catchUp.mock.calls[1]![0].aborted).toBe(false);
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    "Conversation snapshot timed out; observation will retry",
  );
  pane.binding.abort();
  await pane.done;
});

it("aborts running fallback on hide and resumes immediately when shown", async () => {
  vi.useFakeTimers();
  let available = false;
  const slot = oneSlot();
  const page = browserPage();
  const catchUp = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  );
  const pane = observe(
    page,
    () => (available ? slot() : Promise.resolve(null)),
    () => 1,
    catchUp,
  );
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
  page.show(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(catchUp.mock.calls[0]![0].aborted).toBe(true);
  available = true;
  page.show(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(pane.pump).toHaveBeenCalledTimes(1);
  pane.binding.abort();
  await pane.done;
});

it("reports unexpected late snapshot failure after cancellation", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  let fail!: (error: Error) => void;
  const catchUp = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const pane = observe(
    browserPage(),
    async () => null,
    () => 1,
    catchUp,
  );
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
  pane.binding.abort();
  await pane.done;
  const error = new Error("snapshot failed");
  fail(error);
  await vi.advanceTimersByTimeAsync(0);
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    "Conversation snapshot failed after cancellation",
    error,
  );
});

it("preempts fallback when its pane gains stream priority", async () => {
  vi.useFakeTimers();
  const page = browserPage();
  const acquire = oneSlot();
  let selected = "a";
  const a = observe(page, acquire, () => (selected === "a" ? 2 : 1));
  let finish!: () => void;
  const catchUp = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const b = observe(page, acquire, () => (selected === "b" ? 2 : 1), catchUp);
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
  expect(catchUp).toHaveBeenCalledTimes(1);
  selected = "b";
  refreshConversationObservationPriority();
  await vi.advanceTimersByTimeAsync(0);
  expect(catchUp.mock.calls[0]![0].aborted).toBe(true);
  expect(b.pump).toHaveBeenCalledTimes(1);
  finish();
  a.binding.abort();
  b.binding.abort();
  await Promise.all([a.done, b.done]);
});

it("propagates an unexpected active snapshot failure", async () => {
  vi.useFakeTimers();
  const error = new Error("snapshot failed");
  const catchUp = vi.fn(async (_signal: AbortSignal) => {
    throw error;
  });
  const pane = observe(
    browserPage(),
    async () => null,
    () => 1,
    catchUp,
  );
  const rejected = expect(pane.done).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(STREAM_SNAPSHOT_INTERVAL_MS);
  await rejected;
});

it("switches between visible-only membership and real legacy admission on negotiated capability changes", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { locks: {} });
  const page = browserPage();
  const browserListeners = vi.spyOn(page.window, "addEventListener");
  const binding = new AbortController();
  let shared = true;
  let capabilityChanged!: () => void;
  const release = vi.fn(async () => {});
  const acquire = vi.fn(async () => ({ release }));
  const catchUp = vi.fn(async () => {});
  const attempts: { signal: AbortSignal; shared: boolean; resumed: boolean }[] = [];
  const done = observeConversationStream({
    ...page,
    signal: binding.signal,
    multiplexed: () => shared,
    subscribeTransportChanges: (callback) => {
      capabilityChanged = callback;
      return () => {};
    },
    acquire,
    catchUp,
    pump: async (controller, resumed, viaSocket) => {
      attempts.push({ shared: viaSocket, resumed, signal: controller.signal });
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  expect(attempts.map((a) => a.shared)).toEqual([true]);
  expect(acquire).not.toHaveBeenCalled();
  expect(browserListeners).not.toHaveBeenCalled();
  page.show(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(catchUp).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
  page.show(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts[1]).toMatchObject({ shared: true, resumed: true });
  shared = false;
  capabilityChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(attempts[2]).toMatchObject({ shared: false, resumed: true });
  shared = true;
  capabilityChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(release).toHaveBeenCalled();
  expect(attempts[2].signal.aborted).toBe(true);
  expect(attempts[3]).toMatchObject({ shared: true, resumed: true });
  expect(acquire).toHaveBeenCalledTimes(1);
  binding.abort();
  await done;
});
