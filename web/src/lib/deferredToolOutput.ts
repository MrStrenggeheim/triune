// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { AnyBlock } from "./blocks";
import { savedToolBody, type SavedToolBody, type StreamEvent } from "./events";
import { readReferencedEvent } from "./transcriptEventStream";

/** Local symbol prevents untrusted item fields from scheduling extra body reads. */
export function referencedOutputHeader(ref: SavedToolBody): StreamEvent | undefined {
  const item = ref.header.tool_output as Record<string, unknown> | undefined;
  if (
    !item ||
    item.type !== "function_call_output" ||
    item.id !== ref.itemId ||
    item.position !== ref.position ||
    typeof item.call_id !== "string" ||
    typeof item.response_id !== "string"
  )
    return;
  const header = { ...item, output: "Loading saved tool output…", [savedToolBody]: ref };
  return {
    type: "session_item_updated",
    item: header,
    committedItem: header,
    position: ref.position,
  };
}

/** Load bodies outside the ordered header stream; only the exact retained version can publish. */
export function deferredToolOutputs(
  sessionId: string,
  signal: AbortSignal,
  blocks: () => readonly AnyBlock[],
  current: () => boolean,
  publish: (ref: SavedToolBody, output: string, verified: boolean) => void,
) {
  const attempted = new WeakSet<SavedToolBody>();
  let active = 0;
  async function load(ref: SavedToolBody) {
    try {
      const event = await readReferencedEvent(sessionId, ref, signal);
      if (!current()) return;
      const item = event.type === "session_item_updated" ? event.item : event.committedItem;
      const verified = item?.type === "function_call_output" && typeof item.output === "string";
      publish(
        ref,
        verified
          ? String(item.output)
          : "Saved tool output could not be verified. Reopen the conversation to retry.",
        verified,
      );
    } catch {
      if (current())
        publish(
          ref,
          "Saved tool output could not be loaded. Reopen the conversation to retry.",
          false,
        );
    } finally {
      active--;
      scan();
    }
  }
  function scan() {
    if (active >= 2 || signal.aborted || !current()) return;
    for (const block of blocks()) {
      const ref = block.type === "tool_result" ? block[savedToolBody] : undefined;
      if (!ref || attempted.has(ref)) continue;
      attempted.add(ref);
      active++;
      void load(ref);
      if (active >= 2) break;
    }
  }
  return scan;
}
