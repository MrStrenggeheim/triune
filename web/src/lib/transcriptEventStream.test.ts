// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, expect, it, vi } from "vitest";
import { isRetryableTranscriptError } from "./sessionUpdatesSocket";
import {
  transcriptEventStream,
  TRANSCRIPT_QUEUE_BYTES,
  TRANSCRIPT_QUEUE_EVENTS,
  TRANSCRIPT_QUEUE_AGE_MS,
} from "./transcriptEventStream";

const event = { type: "session_transport_error" as const, code: "stream_reconnect" };
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["bytes", "events", "age"])(
  "bounds queued %s and reports incomplete recovery without affecting another membership",
  async (bound) => {
    vi.useFakeTimers();
    const closed = vi.fn();
    const slow = transcriptEventStream(closed);
    const healthy = transcriptEventStream(vi.fn());
    if (bound === "bytes") {
      slow.push(event, TRANSCRIPT_QUEUE_BYTES);
      slow.push(event, 1);
    }
    if (bound === "events") for (let i = 0; i <= TRANSCRIPT_QUEUE_EVENTS; i++) slow.push(event, 1);
    if (bound === "age") {
      slow.push(event, 1);
      vi.advanceTimersByTime(TRANSCRIPT_QUEUE_AGE_MS);
    }
    const reader = slow.body.getReader();
    expect((await reader.read()).value).toEqual({
      type: "session_transport_error",
      code: "stream_overflow",
    });
    expect((await reader.read()).done).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    healthy.push(event, 100);
    const other = healthy.body.getReader();
    expect((await other.read()).value).toEqual(event);
    await other.cancel();
  },
);

it("reclaims consumed bytes and cancels a pending read without double-closing", async () => {
  const closed = vi.fn();
  const stream = transcriptEventStream(closed);
  const reader = stream.body.getReader();
  stream.push(event, TRANSCRIPT_QUEUE_BYTES);
  expect((await reader.read()).value).toEqual(event);
  stream.push(event, TRANSCRIPT_QUEUE_BYTES);
  expect((await reader.read()).value).toEqual(event);
  const pending = reader.read();
  await reader.cancel();
  expect((await pending).done).toBe(true);
  stream.close();
  expect(closed).toHaveBeenCalledTimes(1);
});

it("delivers a supported 1 MiB output with worst-case JSON escaping and explicitly rejects larger frames", async () => {
  const stream = transcriptEventStream(vi.fn());
  const payload = {
    type: "session_item_updated" as const,
    item: {
      id: "tool-output",
      type: "tool_result",
      output: "\u0000".repeat(1024 * 1024),
    },
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify({ type: "session.event", session_id: "chat", event: payload }),
  ).byteLength;
  expect(bytes).toBeGreaterThan(6 * 1024 * 1024);
  stream.push(payload, bytes);
  const reader = stream.body.getReader();
  expect((await reader.read()).value).toBe(payload);
  stream.push(event, TRANSCRIPT_QUEUE_BYTES + 1);
  expect((await reader.read()).value).toEqual({
    type: "session_transport_error",
    code: "stream_event_too_large",
  });
  expect((await reader.read()).done).toBe(true);
  expect(isRetryableTranscriptError("stream_event_too_large")).toBe(false);
});
