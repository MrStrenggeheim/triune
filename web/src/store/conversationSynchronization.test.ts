// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionSyncEvent, StreamEvent } from "@/lib/events";
import {
  ConversationSynchronization,
  SYNCHRONIZATION_DEADLINE_MS,
} from "./conversationSynchronization";

const start: SessionSyncEvent = {
  type: "session_sync",
  phase: "start",
  reset: true,
  lastPosition: -1,
  itemCount: 0,
  lastItemId: null,
  streamEpoch: "new",
  itemRevision: 2,
};
const heartbeat = {
  type: "session_heartbeat" as const,
  lastPosition: 99,
  itemCount: 100,
  lastItemId: "tail",
  streamEpoch: "new",
  reconcileRequired: true,
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const row = (position: number): StreamEvent => {
  const item = {
    id: `item-${position}`,
    position,
    type: "message",
    role: "assistant",
    response_id: "turn",
    status: "completed",
    content: [{ type: "output_text", text: "canonical" }],
  };
  return { type: "session_item_updated", item, committedItem: item };
};

it("allows a steadily progressing replay beyond a minute without accepting its checkpoint early", () => {
  const owner = new ConversationSynchronization();
  const recover = vi.fn();
  const attempt = owner.begin(true, recover);
  const boundary = { ...start, itemCount: 3, lastPosition: 2, lastItemId: "item-2" };
  attempt.accept(boundary, []);
  for (let position = 0; position < 3; position++) {
    vi.advanceTimersByTime(30_000);
    attempt.accept(row(position), []);
    expect(owner.cursor).toBeUndefined();
  }
  expect(attempt.accept({ ...boundary, phase: "complete" }, [])).toHaveLength(3);
  expect(owner.cursor?.after_position).toBe(2);
  expect(recover).not.toHaveBeenCalled();
});

it("does not extend progress for duplicate rows, repeated prefixes or live deltas", () => {
  const owner = new ConversationSynchronization();
  const recover = vi.fn();
  const attempt = owner.begin(true, recover);
  const boundary = { ...start, itemCount: 2, lastPosition: 1, lastItemId: "item-1" };
  attempt.accept(boundary, []);
  attempt.accept(row(0), []);
  for (let index = 0; index < 5; index++) {
    vi.advanceTimersByTime(10_000);
    attempt.accept(boundary, []);
    attempt.accept(row(0), []);
    attempt.accept(row(0), []);
    attempt.heartbeat(heartbeat);
    attempt.accept({ type: "text_delta", delta: "live" }, []);
  }
  vi.advanceTimersByTime(10_000);
  expect(recover).toHaveBeenCalledExactlyOnceWith(true, "deadline");
  expect(owner.cursor).toBeUndefined();
});

it("ignores readiness with a changed epoch until exact replay completion", () => {
  const owner = new ConversationSynchronization();
  owner.cursor = { after_position: 10, stream_epoch: "old" };
  const recover = vi.fn();
  const attempt = owner.begin(true, recover);
  attempt.heartbeat(heartbeat);
  expect(recover).not.toHaveBeenCalled();
  expect(owner.cursor.stream_epoch).toBe("old");
  attempt.accept(start, []);
  attempt.accept({ ...start, phase: "complete" }, []);
  expect(owner.phase).toBe("live");
  expect(owner.cursor).toEqual({ after_position: -1, after_revision: 2, stream_epoch: "new" });
  attempt.heartbeat(heartbeat);
  attempt.heartbeat(heartbeat);
  expect(recover).toHaveBeenCalledExactlyOnceWith(false, "diverged");
});

it("bounds synchronization churn despite heartbeats and repeated starts, but not quiet live models", () => {
  const owner = new ConversationSynchronization();
  const recover = vi.fn();
  const attempt = owner.begin(true, recover);
  for (let index = 0; index < 5; index++) {
    vi.advanceTimersByTime(SYNCHRONIZATION_DEADLINE_MS / 6);
    attempt.heartbeat(heartbeat);
    attempt.accept(start, []);
  }
  expect(recover).not.toHaveBeenCalled();
  vi.advanceTimersByTime(SYNCHRONIZATION_DEADLINE_MS / 6);
  expect(recover).toHaveBeenCalledExactlyOnceWith(true, "deadline");
  attempt.accept({ ...start, phase: "complete" }, []);
  expect(owner.cursor).toBeUndefined();
  const live = owner.begin(true, recover);
  live.accept(start, []);
  live.accept({ ...start, phase: "complete" }, []);
  vi.advanceTimersByTime(SYNCHRONIZATION_DEADLINE_MS * 20);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(owner.phase).toBe("live");
});

it("fences stale completion and timer cleanup from a successor attempt", () => {
  const owner = new ConversationSynchronization();
  const old = owner.begin(true, vi.fn());
  old.accept(start, []);
  const recover = vi.fn();
  const current = owner.begin(true, recover);
  old.stop();
  old.accept({ ...start, phase: "complete" }, []);
  expect(owner.cursor).toBeUndefined();
  expect(owner.phase).toBe("awaiting_sync");
  current.accept(start, []);
  current.accept({ ...start, phase: "complete", itemCount: 1 }, []);
  expect(recover).toHaveBeenCalledExactlyOnceWith(true, "invalid_sync");
  expect(current.identity.attemptGeneration).toBe(2);
  expect(current.identity.syncGeneration).toBe(1);
  expect(current.identity.bindingId).toBe(old.identity.bindingId);
  expect(current.identity.attemptId).not.toBe(old.identity.attemptId);
});

it("acknowledges contiguous applied changes, including amendments to old positions", () => {
  const owner = new ConversationSynchronization();
  const recover = vi.fn();
  const attempt = owner.begin(true, recover);
  const opening = { ...start, streamEpoch: "feed2:test" };
  attempt.accept(opening, []);
  attempt.accept({ ...opening, phase: "complete" }, []);
  expect(attempt.appliedChange(4, 3)).toBeUndefined();
  expect(owner.cursor?.after_revision).toBe(2);
  expect(attempt.appliedChange(3, 1)).toEqual({
    after_position: 3,
    after_revision: 4,
    stream_epoch: "feed2:test",
  });
  expect(attempt.appliedChange(5, 0)?.after_position).toBe(3);
  attempt.heartbeat({
    ...heartbeat,
    streamEpoch: "feed2:test",
    lastPosition: 3,
    itemRevision: 5,
    reconcileRequired: false,
  });
  expect(recover).not.toHaveBeenCalled();
  expect(attempt.appliedChange(5, 0)).toBeUndefined();
  attempt.heartbeat({
    ...heartbeat,
    streamEpoch: "feed2:test",
    lastPosition: 4,
    itemRevision: 6,
    reconcileRequired: false,
  });
  expect(recover).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  attempt.appliedChange(6, 4);
  vi.advanceTimersByTime(2000);
  expect(recover).not.toHaveBeenCalled();
  attempt.heartbeat({
    ...heartbeat,
    streamEpoch: "feed2:test",
    lastPosition: 5,
    itemRevision: 7,
    reconcileRequired: false,
  });
  vi.advanceTimersByTime(2000);
  expect(recover).toHaveBeenCalledExactlyOnceWith(false, "diverged");
});
