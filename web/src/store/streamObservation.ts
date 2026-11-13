// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { StreamSlot } from "./streamSlots";

export const STREAM_SLOT_RETRY_MS = 1000;
export const STREAM_SNAPSHOT_INTERVAL_MS = 5000;

interface ObservationOptions {
  signal: AbortSignal;
  initialSlot?: StreamSlot;
  acquire: () => Promise<StreamSlot | null>;
  pump: (controller: AbortController, resumed: boolean) => Promise<void>;
  catchUp: () => Promise<void>;
  priority?: () => number;
  /** Tests and embedded hosts can supply their own document/focus state. */
  document?: Document;
  window?: Window;
}

interface Observer {
  priority: () => number;
  waiting: boolean;
  changed: () => void;
}
const observers = new Set<Observer>();
const snapshotWaiters: (() => void)[] = [];
let activeSnapshots = 0;

async function snapshotTurn(run: () => Promise<void>): Promise<void> {
  if (activeSnapshots >= 2)
    await new Promise<void>((resolve) => {
      snapshotWaiters.push(resolve);
    });
  else activeSnapshots++;
  try {
    await run();
  } finally {
    const next = snapshotWaiters.shift();
    if (next) next();
    else activeSnapshots--;
  }
}

/** Pane focus changes can reclaim a lower-priority observation without rebinding its model. */
export function refreshConversationObservationPriority(): void {
  for (const observer of observers) observer.changed();
}

/** Own observation only: yielding never cancels a send, save, shell or agent. */
export async function observeConversationStream(options: ObservationOptions): Promise<void> {
  const page = options.document ?? globalThis.document;
  const browser = options.window ?? globalThis.window;
  // A visible unfocused window still receives bounded snapshots.
  let focused = typeof page?.hasFocus === "function" ? page.hasFocus() : true;
  // Non-browser hosts have no window-focus contract (including jsdom).
  if (typeof navigator === "undefined" || !navigator.locks) focused = true;
  let attempt: AbortController | null = null;
  let wake: (() => void) | undefined;
  let lastCatchUp = Date.now();
  let resumed = false;
  let announcedWaiting = false;
  let initialSlot = options.initialSlot ?? null;
  const visible = () => !page || page.visibilityState !== "hidden";
  const priority = () => (visible() && focused ? (options.priority?.() ?? 1) : 0);
  const higherPriorityWaiting = () =>
    [...observers].some(
      (other) => other !== observer && other.waiting && other.priority() > priority(),
    );
  const changed = () => {
    if (!visible() || !focused || higherPriorityWaiting()) attempt?.abort();
    wake?.();
  };
  const observer: Observer = { priority, waiting: true, changed };
  observers.add(observer);
  const focus = () => {
    focused = true;
    changed();
  };
  const blur = () => {
    focused = false;
    changed();
  };
  const abort = () => {
    attempt?.abort();
    wake?.();
  };
  const pause = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, STREAM_SLOT_RETRY_MS);
      wake = done;
      if (options.signal.aborted) done();
    });
  page?.addEventListener("visibilitychange", changed);
  browser?.addEventListener("focus", focus);
  browser?.addEventListener("blur", blur);
  options.signal.addEventListener("abort", abort);
  /* eslint-disable no-await-in-loop -- One observation owns one slot at a time. */
  try {
    while (!options.signal.aborted) {
      let slot: StreamSlot | null = initialSlot;
      initialSlot = null;
      observer.waiting = true;
      if (!slot && visible() && focused && !higherPriorityWaiting()) slot = await options.acquire();
      if (!slot) {
        resumed = true;
        if (!announcedWaiting) {
          announcedWaiting = true;
          refreshConversationObservationPriority();
        }
      }
      if (options.signal.aborted || !visible() || !focused) {
        await slot?.release();
      } else if (slot) {
        observer.waiting = false;
        announcedWaiting = false;
        const controller = new AbortController();
        attempt = controller;
        // Release immediately on hide/blur, even if the transport is slow to unwind.
        const release = () => void slot.release();
        controller.signal.addEventListener("abort", release, { once: true });
        try {
          await options.pump(controller, resumed);
        } finally {
          attempt = null;
          controller.signal.removeEventListener("abort", release);
          await slot.release();
        }
        if (!controller.signal.aborted) return;
        resumed = true;
      }
      if (
        visible() &&
        !options.signal.aborted &&
        Date.now() - lastCatchUp >= STREAM_SNAPSHOT_INTERVAL_MS
      ) {
        // Serialized with the next retry; an exhausted budget never strands a pane.
        lastCatchUp = Date.now();
        await snapshotTurn(async () => {
          if (visible() && !options.signal.aborted) await options.catchUp();
        });
        resumed = true;
      }
      await pause();
    }
  } finally {
    observers.delete(observer);
    abort();
    page?.removeEventListener("visibilitychange", changed);
    browser?.removeEventListener("focus", focus);
    browser?.removeEventListener("blur", blur);
    options.signal.removeEventListener("abort", abort);
  }
  /* eslint-enable no-await-in-loop */
}
