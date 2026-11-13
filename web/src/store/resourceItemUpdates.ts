// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { AnyBlock } from "@/lib/blocks";

/** Refresh loaded lifecycle items; item identity and transcript position are immutable. */
export function updateLoadedResourceItems(
  blocks: AnyBlock[],
  items: readonly Record<string, unknown>[],
  baseline?: readonly AnyBlock[],
): AnyBlock[] {
  const updates = new Map(
    items
      .filter((item) => item.type === "resource_event" && typeof item.id === "string")
      .map((item) => [item.id, item]),
  );
  const before =
    baseline &&
    new Map(
      baseline
        .filter((block) => block.type === "native_tool")
        .map((block) => [block.ctx.itemId, block.data]),
    );
  let changed = false;
  const next = blocks.map((block) => {
    if (block.type !== "native_tool") return block;
    const item = updates.get(block.ctx.itemId);
    if (!item || item === block.data || (before && before.get(block.ctx.itemId) !== block.data))
      return block;
    if (
      ["type", "id", "resource_type", "resource_id", "response_id", "event_type"].some(
        (key) => item[key] !== block.data[key],
      )
    )
      return block;
    changed = true;
    return { ...block, data: item };
  });
  return changed ? next : blocks;
}
