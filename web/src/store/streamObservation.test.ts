// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, expect, it, vi } from "vitest";
import {
  observeConversationStream,
  STREAM_SNAPSHOT_INTERVAL_MS,
  refreshConversationObservationPriority,
} from "./streamObservation";
import { getStreamSlotManager, resetStreamSlotManager } from "./streamSlots";

const controllers: AbortController[] = [];
afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.abort());
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
) {
  const binding = new AbortController();
  controllers.push(binding);
  const catchUp = vi.fn(async () => {});
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
  });
  return { binding, catchUp, pump, done };
}

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
