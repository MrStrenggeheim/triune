// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ConversationItem } from "./conversationItems";
import { savedToolBody } from "./events";
import { deferredToolOutputs, referencedOutputHeader } from "./deferredToolOutput";
import { itemsToBlocks } from "./itemsToBlocks";
import { afterEach, expect, it, vi } from "vitest";
import { isRetryableTranscriptError } from "./sessionUpdatesSocket";
import {
  readReferencedEvent,
  transcriptEventStream,
  TRANSCRIPT_QUEUE_BYTES,
  TRANSCRIPT_QUEUE_EVENTS,
  TRANSCRIPT_QUEUE_AGE_MS,
} from "./transcriptEventStream";

const event = { type: "session_transport_error" as const, code: "stream_reconnect" };
afterEach(() => {
  vi.unstubAllGlobals();
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

it.each(["digest", "length", "identity", "denied", "changed"] as const)(
  "rejects an unusable exact read (%s)",
  async (failure) => {
    const digest = "0".repeat(64);
    const body = JSON.stringify({ id: failure === "identity" ? "other" : "item", position: 2 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: failure === "denied" ? 403 : failure === "changed" ? 409 : 200,
            headers: { etag: failure === "digest" ? "wrong" : `"${digest}"` },
          }),
      ),
    );
    const outcome = await readReferencedEvent(
      "parent",
      {
        type: "session_item_reference",
        header: { type: "response.output_item.done" },
        itemId: "item",
        position: 2,
        sha256: digest,
        byteLength: body.length - (failure === "length" ? 1 : 0),
      },
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      type: "session_transport_error",
      code:
        failure === "denied"
          ? "saved_item_unavailable"
          : failure === "changed"
            ? "stream_reconnect"
            : "invalid_item_reference",
    });
  },
);

it("reads a digest- and identity-checked server response on plain HTTP without SubtleCrypto", async () => {
  vi.stubGlobal("crypto", {});
  const body = JSON.stringify({
    id: "saved",
    position: 2,
    type: "function_call_output",
    call_id: "call",
    output: "kept",
  });
  const digest = "a".repeat(64);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { headers: { etag: `W/"${digest}"` } })),
  );
  const resolved = await readReferencedEvent(
    "parent",
    {
      type: "session_item_reference",
      header: { type: "response.output_item.done" },
      itemId: "saved",
      position: 2,
      sha256: digest,
      byteLength: body.length,
    },
    new AbortController().signal,
  );
  expect(resolved.committedItem).toEqual(JSON.parse(body));
});

it("publishes a saved tool row immediately and verifies its body independently", async () => {
  const { type, ...raw } = {
    type: "response.output_item.done",
    id: "saved",
    position: 2,
    response_id: "turn",
    call_id: "call",
  };
  const summary = { ...raw, type: "function_call_output" };
  const body = JSON.stringify({ ...summary, output: "complete verified output" });
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const ref = {
    type: "session_item_reference" as const,
    header: { type, tool_output: summary },
    itemId: raw.id,
    position: raw.position,
    sha256: digest,
    byteLength: body.length,
  };
  const header = referencedOutputHeader(ref);
  expect(header?.committedItem?.output).toBe("Loading saved tool output…");
  const blocks = itemsToBlocks([header!.committedItem as unknown as ConversationItem]);
  expect(blocks[0].type === "tool_result" && blocks[0][savedToolBody]).toBe(ref);
  let respond!: (value: Response) => void;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((r) => {
        respond = r;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const published = vi.fn();
  const scan = deferredToolOutputs(
    "chat",
    new AbortController().signal,
    () => blocks,
    () => true,
    published,
  );
  scan();
  scan();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(published).not.toHaveBeenCalled();
  respond(new Response(body, { headers: { etag: `W/"${digest}"` } }));
  await vi.waitFor(() =>
    expect(published).toHaveBeenCalledWith(ref, "complete verified output", true),
  );
});
