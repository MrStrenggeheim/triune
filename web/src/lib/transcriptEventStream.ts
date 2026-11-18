// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { StreamEvent } from "./events";
import { authenticatedFetch } from "./identity";
import { parseEvent } from "./sse";

export const TRANSCRIPT_QUEUE_EVENTS = 1024;
// A supported 1 MiB tool output may expand sixfold under JSON escaping.
export const TRANSCRIPT_QUEUE_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPT_QUEUE_AGE_MS = 30_000;

/** A slow membership cannot retain unbounded parsed frames or stale replay. */
export function transcriptEventStream(onClose: () => void) {
  const queue: { event: StreamEvent; bytes: number; at: number }[] = [];
  let bytes = 0;
  let ended = false;
  let waiting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<StreamEvent>;
  const arm = () => {
    clearTimeout(timer);
    if (queue.length && !ended)
      timer = setTimeout(overflow, Math.max(0, queue[0].at + TRANSCRIPT_QUEUE_AGE_MS - Date.now()));
  };
  const drain = () => {
    if (!waiting) return;
    const next = queue.shift();
    if (next) {
      bytes -= next.bytes;
      waiting = false;
      controller.enqueue(next.event);
      arm();
    } else if (ended) {
      waiting = false;
      controller.close();
    }
  };
  const close = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    onClose();
    drain();
  };
  const overflow = (code = "stream_overflow") => {
    queue.length = 0;
    bytes = 0;
    queue.push({
      event: { type: "session_transport_error", code },
      bytes: 0,
      at: Date.now(),
    });
    close();
  };
  const body = new ReadableStream<StreamEvent>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        waiting = true;
        drain();
      },
      cancel() {
        waiting = false;
        queue.length = 0;
        bytes = 0;
        close();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    close,
    push(event: StreamEvent, size: number) {
      if (ended) return;
      if (size > TRANSCRIPT_QUEUE_BYTES) {
        overflow("stream_event_too_large");
        return;
      }
      if (
        queue.length >= TRANSCRIPT_QUEUE_EVENTS ||
        bytes + size > TRANSCRIPT_QUEUE_BYTES ||
        (queue.length && Date.now() - queue[0].at >= TRANSCRIPT_QUEUE_AGE_MS)
      ) {
        overflow();
        return;
      }
      queue.push({ event, bytes: size, at: Date.now() });
      bytes += size;
      drain();
      arm();
    },
  };
}

/** Reader API also supports browsers without ReadableStream async iteration. */
export async function* readTranscriptEvents(
  body: ReadableStream<StreamEvent>,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Resolve a saved body in transcript order, before its synchronization boundary is consumed. */
export async function readReferencedEvent(
  sessionId: string,
  ref: Extract<StreamEvent, { type: "session_item_reference" }>,
  signal: AbortSignal,
): Promise<StreamEvent> {
  const invalid: StreamEvent = { type: "session_transport_error", code: "invalid_item_reference" };
  const consumed = ref.header.type === "session.input.consumed";
  const query = new URLSearchParams({
    position: String(ref.position),
    sha256: ref.sha256,
    consumed: String(consumed),
  });
  try {
    const response = await authenticatedFetch(
      `/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(ref.itemId)}/stream-content?${query}`,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
    );
    if (!response.ok) {
      // A changed item needs a fresh checkpoint; denial or a missing endpoint stops this stream.
      return {
        type: "session_transport_error",
        code:
          response.status === 409
            ? "stream_reconnect"
            : response.status >= 500
              ? "stream_failed"
              : "saved_item_unavailable",
      };
    }
    if (!response.body || response.headers.get("etag")?.replace(/^W\//, "") !== `"${ref.sha256}"`) {
      await response.body?.cancel();
      return invalid;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- A reference owns one sequential, bounded response.
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > ref.byteLength) return invalid;
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (size !== ref.byteLength) return invalid;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    if (globalThis.crypto?.subtle) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== ref.sha256)
        return invalid;
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<
      string,
      unknown
    >;
    const fields = consumed ? (ref.header.data as Record<string, unknown>) : body;
    if (
      !fields ||
      fields[consumed ? "item_id" : "id"] !== ref.itemId ||
      fields.position !== ref.position
    )
      return invalid;
    return (
      parseEvent(
        String(ref.header.type),
        consumed
          ? { ...ref.header, data: { ...fields, data: body } }
          : { ...ref.header, item: body },
      ) ?? invalid
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return error instanceof RangeError || error instanceof SyntaxError
      ? invalid
      : { type: "session_transport_error", code: "stream_failed" };
  }
}
