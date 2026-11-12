// Modified for Triune.
import { createElement, type MouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCompletedNotifications,
  getNotificationSnapshot,
  hideNotification,
  notify,
  removeNotification,
  runNotificationAction,
  setNotificationCenterOpen,
  setShowReadNotifications,
  SHOW_READ_NOTIFICATIONS_STORAGE_KEY,
  setNotificationPaused,
  subscribeNotifications,
  toast,
  updateNotification,
} from "./notifications";

const event = { preventDefault: vi.fn() } as unknown as MouseEvent<HTMLButtonElement>;
const entry = (id: string | number) =>
  getNotificationSnapshot().entries.find((item) => item.id === id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
  toast.dismiss();
  setNotificationCenterOpen(false);
  setShowReadNotifications(true);
});
afterEach(() => {
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("notification snapshots", () => {
  it("persists the history filter without changing unread counts or popup visibility", () => {
    const id = toast("Saved");
    const before = entry(id);
    setShowReadNotifications(false);
    expect(getNotificationSnapshot().showRead).toBe(false);
    expect(entry(id)).toBe(before);
    expect(localStorage.getItem(SHOW_READ_NOTIFICATIONS_STORAGE_KEY)).toBe("false");
    setShowReadNotifications(true);
    expect(getNotificationSnapshot().showRead).toBe(true);
    expect(localStorage.getItem(SHOW_READ_NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  });

  it("keeps the live history filter working when storage is denied", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage denied");
    });
    expect(() => setShowReadNotifications(false)).not.toThrow();
    expect(getNotificationSnapshot().showRead).toBe(false);
  });

  it.each([
    [null, true],
    ["invalid", true],
    ["false", false],
  ])(
    "restores the saved history preference %s when the module reloads",
    async (stored, expected) => {
      if (stored !== null) localStorage.setItem(SHOW_READ_NOTIFICATIONS_STORAGE_KEY, stored);
      vi.resetModules();
      const reloaded = await import("./notifications");
      expect(reloaded.getNotificationSnapshot().showRead).toBe(expected);
    },
  );

  it("retains newly seen entries for one visit without marking old entries unread again", () => {
    const old = toast("Old");
    setNotificationCenterOpen(true);
    expect(entry(old)).toMatchObject({ unread: false, seenInCurrentVisit: true });
    setNotificationCenterOpen(false);
    const fresh = toast("Fresh");
    setNotificationCenterOpen(true);
    expect(entry(old)).toMatchObject({ unread: false, seenInCurrentVisit: false });
    expect(entry(fresh)).toMatchObject({ unread: false, seenInCurrentVisit: true });
    const arriving = toast("While open");
    expect(entry(arriving)).toMatchObject({ unread: false, seenInCurrentVisit: true });
    updateNotification(old, { title: "Revealed again" }, { reveal: true });
    expect(entry(old)).toMatchObject({ unread: false, seenInCurrentVisit: true });
    setNotificationCenterOpen(false);
    expect(getNotificationSnapshot().entries.every((item) => !item.seenInCurrentVisit)).toBe(true);
  });

  it("publishes stable immutable snapshots and unsubscribes listeners", () => {
    const initial = getNotificationSnapshot();
    const listener = vi.fn();
    const unsubscribe = subscribeNotifications(listener);
    expect(getNotificationSnapshot()).toBe(initial);
    const progress = { active: true, value: 10 };
    const action = { label: "Stop", onClick: vi.fn() };
    const id = notify({ title: "Uploading", progress, action });
    const next = getNotificationSnapshot();
    expect(next).not.toBe(initial);
    expect(getNotificationSnapshot()).toBe(next);
    expect(initial.entries).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    for (const value of [next, next.entries, entry(id), entry(id)?.action, entry(id)?.progress])
      expect(Object.isFrozen(value)).toBe(true);
    progress.value = 50;
    action.label = "Changed outside";
    expect(entry(id)?.progress?.value).toBe(10);
    expect(entry(id)?.action).toMatchObject({ label: "Stop" });
    unsubscribe();
    updateNotification(id, { description: "Chunk received" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(next.entries[0].description).toBeUndefined();
  });

  it("marks history seen on opening and arrivals while open stay read", () => {
    const first = toast("First");
    expect(entry(first)?.unread).toBe(true);
    setNotificationCenterOpen(true);
    expect(getNotificationSnapshot().centerOpen).toBe(true);
    expect(entry(first)?.unread).toBe(false);
    const second = toast("Second");
    expect(entry(second)?.unread).toBe(false);
    setNotificationCenterOpen(false);
    updateNotification(first, { title: "Updated" });
    expect(entry(first)?.unread).toBe(false);
    updateNotification(first, {}, { reveal: true });
    expect(entry(first)?.unread).toBe(true);
    expect(entry(second)?.unread).toBe(false);
  });

  it("preserves creation time, id, function titles and React nodes across patches", () => {
    const title = () => createElement("strong", null, "Completed");
    const description = createElement("em", null, "Details");
    const id = toast(title, { description, id: "stable", testId: "notice" });
    const createdAt = entry(id)!.createdAt;
    expect(entry(id)?.description).toBe(description);
    vi.advanceTimersByTime(100);
    updateNotification(id, { id: "different", createdAt: 0, description: () => "New details" });
    expect(entry(id)).toMatchObject({
      id: "stable",
      title,
      createdAt,
      updatedAt: createdAt + 100,
      testId: "notice",
    });
    expect(entry("different")).toBeUndefined();
  });

  it("ignores lifecycle calls for missing ids", async () => {
    const before = getNotificationSnapshot();
    updateNotification("missing", { title: "Changed" }, { reveal: true });
    hideNotification("missing");
    removeNotification("missing");
    setNotificationPaused("missing", true, "focus");
    await runNotificationAction("missing", "action", event);
    expect(getNotificationSnapshot()).toBe(before);
  });
});

describe("popup lifecycle", () => {
  it.each([
    ["normal", 10_000],
    ["success", 10_000],
    ["info", 10_000],
    ["warning", 12_000],
    ["error", 15_000],
  ] as const)("collapses %s after %i ms while preserving history", (type, duration) => {
    const id = notify({ title: type, type });
    vi.advanceTimersByTime(duration - 1);
    expect(entry(id)?.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(entry(id)?.visible).toBe(false);
    expect(toast.getHistory()).toHaveLength(1);
    expect(toast.getToasts()).toEqual([]);
  });

  it.each([Infinity, 0, -1])("keeps duration %s sticky", (duration) => {
    const id = toast("Sticky", { duration });
    vi.advanceTimersByTime(1_000_000);
    expect(entry(id)?.visible).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps loading and required prompts visible despite finite durations", () => {
    const loading = toast.loading("Working", { duration: 1 });
    const required = toast("Permission required", { dismissible: false, duration: 1 });
    vi.advanceTimersByTime(100_000);
    expect(entry(loading)?.visible).toBe(true);
    expect(entry(required)?.visible).toBe(true);
    updateNotification(loading, { type: "success", duration: undefined });
    vi.advanceTimersByTime(9999);
    expect(entry(loading)?.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(entry(loading)?.visible).toBe(false);
  });

  it("keeps original expiry across chunk updates and reveals completion for a fresh 10s", () => {
    const id = notify({ title: "Upload", progress: { active: true, value: 0 } });
    vi.advanceTimersByTime(6000);
    updateNotification(id, { progress: { active: true, value: 50 } });
    vi.advanceTimersByTime(4000);
    expect(entry(id)?.visible).toBe(false);
    updateNotification(id, { progress: { active: true, value: 80 } });
    expect(entry(id)?.visible).toBe(false);
    updateNotification(
      id,
      { type: "success", progress: { active: false, value: 100 } },
      { reveal: true },
    );
    vi.advanceTimersByTime(9999);
    expect(entry(id)?.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(entry(id)?.visible).toBe(false);
  });

  it("pauses for overlapping pointer and focus reasons and resumes remaining time", () => {
    const id = toast("Read this");
    vi.advanceTimersByTime(3000);
    setNotificationPaused(id, true, "pointer");
    vi.advanceTimersByTime(2000);
    setNotificationPaused(id, true, "focus");
    setNotificationPaused(id, true, "pointer");
    setNotificationPaused(id, false, "pointer");
    vi.advanceTimersByTime(50_000);
    expect(entry(id)?.visible).toBe(true);
    updateNotification(id, { description: "Still paused" });
    setNotificationPaused(id, false, "focus");
    setNotificationPaused(id, false, "focus");
    vi.advanceTimersByTime(6999);
    expect(entry(id)?.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(entry(id)?.visible).toBe(false);
  });

  it("restarts reveals while preserving pointer pause", () => {
    const id = toast("First");
    vi.advanceTimersByTime(5000);
    setNotificationPaused(id, true, "pointer");
    toast("Second", { id });
    vi.advanceTimersByTime(100_000);
    expect(entry(id)?.visible).toBe(true);
    setNotificationPaused(id, false, "pointer");
    vi.advanceTimersByTime(10_000);
    expect(entry(id)?.visible).toBe(false);
    expect(toast.getHistory()).toHaveLength(1);
  });

  it("calls onAutoClose once per reveal and onDismiss once on removal", () => {
    const onAutoClose = vi.fn();
    const onDismiss = vi.fn();
    const id = toast("Notice", { onAutoClose, onDismiss });
    hideNotification(id);
    hideNotification(id);
    vi.advanceTimersByTime(20_000);
    expect(onAutoClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    updateNotification(id, {}, { reveal: true });
    vi.advanceTimersByTime(10_000);
    expect(onAutoClose).toHaveBeenCalledTimes(2);
    removeNotification(id);
    removeNotification(id);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(entry(id)).toBeUndefined();
  });

  it("does not start browser timers during SSR", () => {
    vi.stubGlobal("window", undefined);
    const id = toast("Server render");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100_000);
    expect(entry(id)?.visible).toBe(true);
  });
});

describe("history and compatibility", () => {
  it("retains 100 settled entries plus loading, active progress and required prompts", () => {
    const loading = toast.loading("Loading");
    const progress = notify({ title: "Progress", progress: { active: true } });
    const required = toast.custom(() => createElement("button", null, "Allow"), {
      dismissible: false,
    });
    for (let i = 0; i < 105; i += 1) toast(`Notice ${i}`, { id: `notice-${i}` });
    expect(toast.getHistory()).toHaveLength(103);
    expect(entry("notice-0")).toBeUndefined();
    expect(entry("notice-5")).toBeDefined();
    for (const id of [loading, progress, required]) {
      removeNotification(id);
      expect(entry(id)).toBeDefined();
    }
    clearCompletedNotifications();
    expect(toast.getHistory().map((item) => item.id)).toEqual([loading, progress, required]);
    toast.dismiss(required);
    expect(entry(required)).toBeUndefined();
    toast.dismiss();
    expect(toast.getHistory()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears completed callbacks and discards their countdowns", () => {
    const onDismiss = vi.fn();
    const onAutoClose = vi.fn();
    toast.success("Finished", { onDismiss, onAutoClose });
    clearCompletedNotifications();
    vi.advanceTimersByTime(20_000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAutoClose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a newly revealed completion when settled history is already full", () => {
    const id = notify({ title: "Long upload", progress: { active: true } });
    hideNotification(id);
    for (let i = 0; i < 100; i += 1) toast(`History ${i}`, { id: `history-${i}` });
    updateNotification(id, { type: "success", progress: { active: false } }, { reveal: true });
    expect(toast.getHistory()).toHaveLength(100);
    expect(entry(id)).toMatchObject({ type: "success", visible: true });
    expect(entry("history-0")).toBeUndefined();
  });

  it("does not allocate an id already supplied explicitly", () => {
    const previous = toast("Previous generated id");
    const reserved = Number(previous) + 1;
    toast("Explicit", { id: reserved });
    const id = toast("Next generated id");
    expect(id).not.toBe(reserved);
    expect(entry(reserved)?.title).toBe("Explicit");
  });

  it("accepts zero and empty string ids and passes the id to custom JSX renderers", () => {
    toast("Zero", { id: 0 });
    toast.message("Empty", { id: "" });
    const jsx = createElement("button", null, "Allow");
    const renderer = vi.fn(() => jsx);
    const id = toast.custom(renderer, { testId: "custom" });
    expect(renderer).toHaveBeenCalledWith(id);
    expect(entry(id)).toMatchObject({ jsx, testId: "custom" });
    toast.dismiss(0);
    expect(entry(0)).toBeUndefined();
    expect(entry("")).toBeDefined();
  });
});

describe("notification actions", () => {
  it.each(["action", "cancel"] as const)(
    "runs %s after collapse and retires both buttons",
    async (kind) => {
      const onClick = vi.fn();
      const onOther = vi.fn();
      const id = toast("Undo", {
        [kind]: { label: "Run", onClick },
        [kind === "action" ? "cancel" : "action"]: { label: "Other", onClick: onOther },
      });
      hideNotification(id);
      await runNotificationAction(id, kind, event);
      expect(onClick).toHaveBeenCalledExactlyOnceWith(event);
      expect(onOther).not.toHaveBeenCalled();
      expect(entry(id)).toMatchObject({ visible: false, actionPending: false });
      expect(entry(id)?.action).toBeUndefined();
      expect(entry(id)?.cancel).toBeUndefined();
      await runNotificationAction(id, kind, event);
      expect(onClick).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["action", "cancel"] as const)(
    "preserves buttons and remaining expiry when %s prevents dismissal",
    async (kind) => {
      const click = new window.MouseEvent("click", {
        cancelable: true,
      }) as unknown as MouseEvent<HTMLButtonElement>;
      const onClick = vi.fn((actionEvent: MouseEvent<HTMLButtonElement>) =>
        actionEvent.preventDefault(),
      );
      const onAutoClose = vi.fn();
      const id = toast("Copy command", {
        action: { label: "Copy", onClick },
        cancel: { label: "Later", onClick },
        onAutoClose,
      });
      vi.advanceTimersByTime(3000);
      await runNotificationAction(id, kind, click);
      expect(click.defaultPrevented).toBe(true);
      expect(entry(id)).toMatchObject({
        visible: true,
        actionPending: false,
        action: { label: "Copy" },
        cancel: { label: "Later" },
      });
      expect(onAutoClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(6999);
      expect(entry(id)?.visible).toBe(true);
      vi.advanceTimersByTime(1);
      expect(entry(id)?.visible).toBe(false);
      expect(onAutoClose).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a prevented legacy action available after background copy failure", async () => {
    let failCopy!: (error: Error) => void;
    const copy = new Promise<void>((_resolve, reject) => {
      failCopy = reject;
    });
    const onDismiss = vi.fn();
    const onClick = vi.fn((actionEvent: MouseEvent<HTMLButtonElement>) => {
      actionEvent.preventDefault();
      void copy.then(
        () => toast.dismiss(id),
        () => toast.error("Could not copy command"),
      );
    });
    const id = toast("Copy command", {
      duration: Infinity,
      action: { label: "Copy", onClick },
      onDismiss,
    });
    const click = new window.MouseEvent("click", {
      cancelable: true,
    }) as unknown as MouseEvent<HTMLButtonElement>;
    await runNotificationAction(id, "action", click);
    failCopy(new Error("Clipboard blocked"));
    await copy.catch(() => {});
    expect(entry(id)).toMatchObject({
      visible: true,
      actionPending: false,
      action: { label: "Copy" },
    });
    expect(toast.getToasts()).toHaveLength(2);
    expect(onDismiss).not.toHaveBeenCalled();
    onClick.mockImplementationOnce((actionEvent) => {
      actionEvent.preventDefault();
      toast.dismiss(id);
    });
    const retry = new window.MouseEvent("click", {
      cancelable: true,
    }) as unknown as MouseEvent<HTMLButtonElement>;
    await runNotificationAction(id, "action", retry);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(entry(id)).toBeUndefined();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("prevents concurrent activation, pauses expiry and protects pending actions", async () => {
    let complete!: () => void;
    const onClick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const cancel = vi.fn();
    const id = toast("Undo", {
      action: { label: "Undo", onClick },
      cancel: { label: "Cancel", onClick: cancel },
    });
    const result = runNotificationAction(id, "action", event);
    expect(entry(id)?.actionPending).toBe(true);
    await runNotificationAction(id, "action", event);
    await runNotificationAction(id, "cancel", event);
    clearCompletedNotifications();
    removeNotification(id);
    vi.advanceTimersByTime(100_000);
    expect(entry(id)?.visible).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    complete();
    await result;
    expect(entry(id)?.visible).toBe(false);
    expect(entry(id)?.action).toBeUndefined();
  });

  it.each(["action", "cancel"] as const)(
    "retires a successful async %s after opening history marks it read",
    async (kind) => {
      let complete!: () => void;
      const onClick = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
      const other = vi.fn();
      const id = toast.success("Archived project", {
        [kind]: { label: "Undo", onClick },
        [kind === "action" ? "cancel" : "action"]: { label: "Other", onClick: other },
      });
      const result = runNotificationAction(id, kind, event);
      expect(entry(id)).toMatchObject({ actionPending: true, unread: true });
      setNotificationCenterOpen(true);
      expect(entry(id)).toMatchObject({ actionPending: true, unread: false });
      complete();
      await result;
      expect(entry(id)).toMatchObject({ actionPending: false, unread: false, visible: false });
      expect(entry(id)?.action).toBeUndefined();
      expect(entry(id)?.cancel).toBeUndefined();
      await runNotificationAction(id, "action", event);
      await runNotificationAction(id, "cancel", event);
      expect(onClick).toHaveBeenCalledExactlyOnceWith(event);
      expect(other).not.toHaveBeenCalled();
    },
  );

  it.each(["timer", "hide", "unchanged content"])(
    "retires a successful async action despite a %s update",
    async (change) => {
      let complete!: () => void;
      const onClick = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
      const id = toast("Undo", { action: { label: "Undo", onClick } });
      const result = runNotificationAction(id, "action", event);
      vi.advanceTimersByTime(1000);
      if (change === "timer") updateNotification(id, { duration: 30_000 });
      else if (change === "hide") hideNotification(id);
      else updateNotification(id, { title: "Undo", action: { label: "Undo", onClick } });
      complete();
      await result;
      expect(entry(id)).toMatchObject({ actionPending: false, visible: false });
      expect(entry(id)?.action).toBeUndefined();
      await runNotificationAction(id, "action", event);
      expect(onClick).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves a completion revealed by the action before its promise resolves", async () => {
    let complete!: () => void;
    const onAutoClose = vi.fn();
    const id = notify({
      title: "Uploading",
      progress: { active: true, value: 40 },
      onAutoClose,
      action: {
        label: "Cancel",
        onClick: () => {
          updateNotification(
            id,
            {
              title: "Upload cancelled",
              type: "success",
              progress: { active: false, value: 40 },
              action: undefined,
            },
            { reveal: true },
          );
          return new Promise<void>((resolve) => {
            complete = resolve;
          });
        },
      },
    });
    const result = runNotificationAction(id, "action", event);
    const updated = entry(id)!;
    vi.advanceTimersByTime(2000);
    complete();
    await result;
    expect(entry(id)).toMatchObject({
      title: "Upload cancelled",
      type: "success",
      visible: true,
      actionPending: false,
      progress: { active: false, value: 40 },
      updatedAt: updated.updatedAt,
    });
    expect(onAutoClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9999);
    expect(entry(id)?.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(entry(id)?.visible).toBe(false);
    expect(onAutoClose).toHaveBeenCalledTimes(1);
  });

  it("keeps background cancellation visible and preserves its progress countdown", async () => {
    const onAutoClose = vi.fn();
    let finishCancellation!: () => void;
    const background = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const id = notify({
      title: "Uploading",
      progress: { active: true, value: 40 },
      onAutoClose,
      action: {
        label: "Cancel",
        onClick: () => {
          updateNotification(id, { title: "Cancelling upload", action: undefined });
          void background.then(() => {
            updateNotification(
              id,
              { title: "Upload cancelled", progress: { active: false, value: 40 } },
              { reveal: true },
            );
          });
        },
      },
    });
    vi.advanceTimersByTime(3000);
    await runNotificationAction(id, "action", event);
    expect(entry(id)).toMatchObject({
      title: "Cancelling upload",
      visible: true,
      actionPending: false,
      progress: { active: true, value: 40 },
    });
    expect(entry(id)?.action).toBeUndefined();
    expect(onAutoClose).not.toHaveBeenCalled();
    clearCompletedNotifications();
    expect(entry(id)).toBeDefined();
    vi.advanceTimersByTime(6999);
    expect(entry(id)?.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(entry(id)?.visible).toBe(false);
    finishCancellation();
    await background;
    expect(entry(id)).toMatchObject({ title: "Upload cancelled", visible: true });
    vi.advanceTimersByTime(10_000);
    expect(entry(id)?.visible).toBe(false);
    expect(onAutoClose).toHaveBeenCalledTimes(2);
  });

  it("preserves externally replaced actions after an earlier callback completes", async () => {
    const replacement = vi.fn();
    const id = toast("Original", {
      action: {
        label: "Run",
        onClick: () => {
          updateNotification(id, { action: { label: "Next", onClick: replacement } });
        },
      },
    });
    await runNotificationAction(id, "action", event);
    expect(entry(id)).toMatchObject({
      visible: true,
      actionPending: false,
      action: { label: "Next" },
    });
    await runNotificationAction(id, "action", event);
    expect(replacement).toHaveBeenCalledExactlyOnceWith(event);
  });

  it.each([new Error("Write refused"), "Write refused"])(
    "reveals failed async actions and permits retry: %s",
    async (error) => {
      const onClick = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
      const id = toast("Restore file", { action: { label: "Restore", onClick } });
      hideNotification(id);
      await runNotificationAction(id, "action", event);
      expect(entry(id)).toMatchObject({
        type: "error",
        description: "Write refused",
        visible: true,
        actionPending: false,
      });
      expect(entry(id)?.action).toBeDefined();
      vi.advanceTimersByTime(14_999);
      expect(entry(id)?.visible).toBe(true);
      vi.advanceTimersByTime(1);
      expect(entry(id)?.visible).toBe(false);
      await runNotificationAction(id, "action", event);
      expect(onClick).toHaveBeenCalledTimes(2);
      expect(entry(id)?.action).toBeUndefined();
    },
  );

  it("handles synchronous errors and accepts JSX actions without executing them", async () => {
    const id = toast("Fail", {
      action: {
        label: "Try",
        onClick: () => {
          throw new Error("Synchronous failure");
        },
      },
    });
    await expect(runNotificationAction(id, "action", event)).resolves.toBeUndefined();
    expect(entry(id)).toMatchObject({
      type: "error",
      description: "Synchronous failure",
      actionPending: false,
    });
    const action = createElement("button", null, "Custom");
    const custom = toast("JSX", { action });
    await runNotificationAction(custom, "action", event);
    expect(entry(custom)?.action).toBe(action);
    expect(entry(custom)?.visible).toBe(true);
  });

  it("does not alter a replacement with the same id when an old action completes", async () => {
    let complete!: () => void;
    const id = toast("Old", {
      id: "replace",
      action: {
        label: "Run",
        onClick: () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      },
    });
    const result = runNotificationAction(id, "action", event);
    toast.dismiss(id);
    toast("Replacement", { id, action: { label: "New", onClick: vi.fn() } });
    complete();
    await result;
    expect(entry(id)).toMatchObject({
      title: "Replacement",
      visible: true,
      action: { label: "New" },
    });
  });

  it("reports failures even if legacy callback cleanup removed the source", async () => {
    const id = toast("Old", {
      action: {
        label: "Fail",
        onClick: async () => {
          toast.dismiss(id);
          throw new Error("Failed after cleanup");
        },
      },
    });
    await runNotificationAction(id, "action", event);
    expect(entry(id)).toBeUndefined();
    expect(toast.getToasts()[0]).toMatchObject({
      type: "error",
      description: "Failed after cleanup",
    });
  });
});
