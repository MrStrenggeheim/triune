// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { StreamEvent } from "./events";

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
