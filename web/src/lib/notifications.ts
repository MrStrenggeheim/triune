// Modified for Triune.
import type { MouseEvent, ReactNode } from "react";
import type { Action, ExternalToast, ToastT } from "sonner";

export type { Action, ExternalToast, ToastT } from "sonner";

export interface NotificationEntry extends ToastT {
  createdAt: number;
  updatedAt: number;
  visible: boolean;
  unread: boolean;
  /** Newly seen entries stay visible until this center visit ends. */
  seenInCurrentVisit?: boolean;
  progress?: { value?: number; label?: string; active: boolean };
  actionPending?: boolean;
}

type NotificationId = NotificationEntry["id"];
export type NotifyInput = Partial<NotificationEntry> & Pick<NotificationEntry, "title">;
type PauseReason = "pointer" | "focus";
interface NotificationSnapshot {
  entries: NotificationEntry[];
  centerOpen: boolean;
  showRead: boolean;
}
interface Countdown {
  remaining: number;
  deadline?: number;
  timer?: ReturnType<typeof setTimeout>;
  paused: Set<PauseReason>;
}

export const SHOW_READ_NOTIFICATIONS_STORAGE_KEY = "omnigent:notifications:show-read";

function readShowReadNotifications(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SHOW_READ_NOTIFICATIONS_STORAGE_KEY) !== "false";
  } catch {
    // Unavailable storage preserves the existing unfiltered history.
    return true;
  }
}

let nextId = 0;
const initialEntries: NotificationEntry[] = [];
Object.freeze(initialEntries);
let snapshot: NotificationSnapshot = Object.freeze({
  entries: initialEntries,
  centerOpen: false,
  showRead: readShowReadNotifications(),
});
const listeners = new Set<() => void>();
const countdowns = new Map<NotificationId, Countdown>();
const actionRuns = new Map<NotificationId, symbol>();

function allocateId(): NotificationId {
  do {
    nextId += 1;
  } while (entryFor(nextId));
  return nextId;
}

function isAction(value: NotificationEntry["action"]): value is Action {
  return (
    typeof value === "object" &&
    value !== null &&
    "onClick" in value &&
    typeof value.onClick === "function"
  );
}

function freezeEntry(entry: NotificationEntry): NotificationEntry {
  return Object.freeze({
    ...entry,
    progress: entry.progress ? Object.freeze({ ...entry.progress }) : undefined,
    action: isAction(entry.action) ? Object.freeze({ ...entry.action }) : entry.action,
    cancel: isAction(entry.cancel) ? Object.freeze({ ...entry.cancel }) : entry.cancel,
  });
}

function sameAction(
  left: NotificationEntry["action"],
  right: NotificationEntry["action"],
): boolean {
  return (
    left === right ||
    (isAction(left) &&
      isAction(right) &&
      left.label === right.label &&
      left.onClick === right.onClick)
  );
}

function hasContentChanged(previous: NotificationEntry, current: NotificationEntry): boolean {
  return (
    previous.title !== current.title ||
    previous.description !== current.description ||
    previous.type !== current.type ||
    previous.jsx !== current.jsx ||
    previous.dismissible !== current.dismissible ||
    !sameAction(previous.action, current.action) ||
    !sameAction(previous.cancel, current.cancel) ||
    previous.progress?.active !== current.progress?.active ||
    previous.progress?.value !== current.progress?.value ||
    previous.progress?.label !== current.progress?.label
  );
}

function protectedEntry(entry: NotificationEntry): boolean {
  return (
    entry.type === "loading" ||
    entry.progress?.active === true ||
    entry.dismissible === false ||
    entry.actionPending === true
  );
}

function stopCountdown(id: NotificationId): void {
  const countdown = countdowns.get(id);
  if (!countdown) return;
  clearTimeout(countdown.timer);
  countdown.timer = undefined;
  if (countdown.deadline !== undefined) {
    countdown.remaining = Math.max(0, countdown.deadline - Date.now());
    countdown.deadline = undefined;
  }
}

function discardCountdown(id: NotificationId): void {
  stopCountdown(id);
  countdowns.delete(id);
}

function publish(
  entries: NotificationEntry[],
  centerOpen = snapshot.centerOpen,
  showRead = snapshot.showRead,
): void {
  let settled = entries.filter((entry) => !protectedEntry(entry)).length;
  const retained = entries.filter((entry) => {
    if (settled <= 100 || protectedEntry(entry)) return true;
    settled -= 1;
    discardCountdown(entry.id);
    return false;
  });
  Object.freeze(retained);
  snapshot = Object.freeze({ entries: retained, centerOpen, showRead });
  for (const listener of listeners) listener();
}

function entryFor(id: NotificationId): NotificationEntry | undefined {
  return snapshot.entries.find((entry) => entry.id === id);
}

function durationFor(entry: NotificationEntry): number {
  if (entry.type === "loading" || entry.dismissible === false) return Infinity;
  if (entry.duration !== undefined) return entry.duration <= 0 ? Infinity : entry.duration;
  return entry.type === "error" ? 15_000 : entry.type === "warning" ? 12_000 : 10_000;
}

function startCountdown(entry: NotificationEntry, reset = false): void {
  let countdown = countdowns.get(entry.id);
  if (reset || !countdown) {
    const paused = countdown?.paused ?? new Set<PauseReason>();
    discardCountdown(entry.id);
    countdown = { remaining: durationFor(entry), paused };
    countdowns.set(entry.id, countdown);
  }
  if (
    !entry.visible ||
    entry.actionPending ||
    countdown.paused.size ||
    countdown.timer !== undefined ||
    !Number.isFinite(countdown.remaining) ||
    typeof window === "undefined"
  )
    return;
  countdown.deadline = Date.now() + countdown.remaining;
  countdown.timer = setTimeout(() => hideNotification(entry.id), countdown.remaining);
}

export function getNotificationSnapshot(): NotificationSnapshot {
  return snapshot;
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setNotificationCenterOpen(centerOpen: boolean): void {
  if (snapshot.centerOpen === centerOpen) return;
  publish(
    snapshot.entries.map((entry) =>
      freezeEntry({
        ...entry,
        unread: centerOpen ? false : entry.unread,
        seenInCurrentVisit: centerOpen && entry.unread,
      }),
    ),
    centerOpen,
  );
}

export function setShowReadNotifications(showRead: boolean): void {
  try {
    if (showRead) window.localStorage.removeItem(SHOW_READ_NOTIFICATIONS_STORAGE_KEY);
    else window.localStorage.setItem(SHOW_READ_NOTIFICATIONS_STORAGE_KEY, "false");
  } catch {
    // The live filter still works if this device cannot save preferences.
  }
  if (snapshot.showRead !== showRead) publish(snapshot.entries, snapshot.centerOpen, showRead);
}

export function notify(input: NotifyInput): NotificationId {
  const id = input.id ?? allocateId();
  if (entryFor(id)) {
    updateNotification(id, input, { reveal: true });
    return id;
  }
  const now = Date.now();
  const entry = freezeEntry({
    ...input,
    id,
    type: input.type ?? "normal",
    createdAt: now,
    updatedAt: now,
    visible: input.visible ?? true,
    unread: !snapshot.centerOpen,
    seenInCurrentVisit: snapshot.centerOpen,
    actionPending: false,
  });
  publish([...snapshot.entries, entry]);
  if (entryFor(id) === entry) startCountdown(entry);
  return id;
}

/** Content/progress patches keep the current expiry unless explicitly revealed. */
export function updateNotification(
  id: NotificationId,
  patch: Partial<NotificationEntry>,
  options: { reveal?: boolean } = {},
): void {
  const previous = entryFor(id);
  if (!previous) return;
  const reveal = options.reveal === true;
  const entry = freezeEntry({
    ...previous,
    ...patch,
    id,
    createdAt: previous.createdAt,
    updatedAt: Date.now(),
    visible: reveal ? true : previous.visible,
    unread: reveal ? !snapshot.centerOpen : previous.unread,
    seenInCurrentVisit: reveal ? snapshot.centerOpen : previous.seenInCurrentVisit,
    actionPending: previous.actionPending,
  });
  const reset = reveal || durationFor(previous) !== durationFor(entry);
  if (!entry.visible) discardCountdown(id);
  publish(
    reveal
      ? [...snapshot.entries.filter((item) => item.id !== id), entry]
      : snapshot.entries.map((item) => (item.id === id ? entry : item)),
  );
  if (entryFor(id) === entry) startCountdown(entry, reset);
}

/** Collapse the popup; its actions remain usable in the notification center. */
export function hideNotification(id: NotificationId): void {
  const entry = entryFor(id);
  if (!entry?.visible) return;
  discardCountdown(id);
  publish(
    snapshot.entries.map((item) =>
      item.id === id ? freezeEntry({ ...entry, visible: false, updatedAt: Date.now() }) : item,
    ),
  );
  entry.onAutoClose?.(entry);
}

function removeEntry(id: NotificationId): void {
  const entry = entryFor(id);
  if (!entry) return;
  actionRuns.delete(id);
  discardCountdown(id);
  publish(snapshot.entries.filter((item) => item.id !== id));
  entry.onDismiss?.(entry);
}

export function removeNotification(id: NotificationId): void {
  const entry = entryFor(id);
  if (entry && !protectedEntry(entry)) removeEntry(id);
}

export function clearCompletedNotifications(): void {
  const completed = snapshot.entries.filter((entry) => !protectedEntry(entry));
  for (const entry of completed) discardCountdown(entry.id);
  publish(snapshot.entries.filter(protectedEntry));
  for (const entry of completed) entry.onDismiss?.(entry);
}

export function setNotificationPaused(
  id: NotificationId,
  paused: boolean,
  reason: PauseReason,
): void {
  const entry = entryFor(id);
  const countdown = countdowns.get(id);
  if (!entry?.visible || !countdown) return;
  if (paused) {
    stopCountdown(id);
    countdown.paused.add(reason);
  } else {
    countdown.paused.delete(reason);
    startCountdown(entry);
  }
}

export async function runNotificationAction(
  id: NotificationId,
  kind: "action" | "cancel",
  event: MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const entry = entryFor(id);
  const action = entry?.[kind];
  if (!entry || entry.actionPending || !isAction(action)) return;
  const run = Symbol();
  actionRuns.set(id, run);
  stopCountdown(id);
  const pending = freezeEntry({ ...entry, actionPending: true });
  publish(snapshot.entries.map((item) => (item.id === id ? pending : item)));
  try {
    await action.onClick(event);
  } catch (error) {
    // An explicit legacy dismiss may remove the item while its callback runs.
    const current = entryFor(id);
    if (current && actionRuns.get(id) === run) {
      actionRuns.delete(id);
      const failed = freezeEntry({
        ...current,
        actionPending: false,
        type: "error",
        description: error instanceof Error ? error.message : String(error),
        duration: undefined,
        visible: true,
        unread: !snapshot.centerOpen,
        updatedAt: Date.now(),
      });
      publish([...snapshot.entries.filter((item) => item.id !== id), failed]);
      startCountdown(failed, true);
    } else {
      toast.error("Notification action failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  const current = entryFor(id);
  if (!current || actionRuns.get(id) !== run) return;
  actionRuns.delete(id);
  if (hasContentChanged(pending, current) || event.defaultPrevented) {
    // Content updates and prevented dismissal own the lifecycle; read/timer/hide changes do not.
    const released = freezeEntry({ ...current, actionPending: false });
    publish(snapshot.entries.map((item) => (item.id === id ? released : item)));
    if (entryFor(id) === released) startCountdown(released);
    return;
  }
  const completed = freezeEntry({
    ...current,
    actionPending: false,
    action: undefined,
    cancel: undefined,
    dismissible: true,
    updatedAt: Date.now(),
  });
  publish(snapshot.entries.map((item) => (item.id === id ? completed : item)));
  if (entryFor(id) === completed) hideNotification(id);
}

function message(title: NotificationEntry["title"], options?: ExternalToast): NotificationId {
  return notify({ ...options, title, type: "normal" });
}

function typedMessage(type: NotificationEntry["type"]): typeof message {
  return (title, options) => notify({ ...options, title, type });
}

export const toast = Object.assign(message, {
  success: typedMessage("success"),
  error: typedMessage("error"),
  warning: typedMessage("warning"),
  info: typedMessage("info"),
  loading: typedMessage("loading"),
  message,
  custom: (
    renderer: (id: NotificationId) => ReactNode,
    options?: ExternalToast,
  ): NotificationId => {
    const id = options?.id ?? allocateId();
    return notify({ ...options, id, title: undefined, jsx: renderer(id), type: "normal" });
  },
  // Explicit cleanup must also retire required prompts and active operations.
  dismiss: (id?: NotificationId): NotificationId | undefined => {
    if (id !== undefined) removeEntry(id);
    else for (const entry of [...snapshot.entries]) removeEntry(entry.id);
    return id;
  },
  getHistory: (): NotificationEntry[] => snapshot.entries,
  getToasts: (): NotificationEntry[] => snapshot.entries.filter((entry) => entry.visible),
});
