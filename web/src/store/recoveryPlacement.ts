// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { AnyBlock } from "@/lib/blocks";

/** Insert missing saved items beside their canonical neighbors without rebuilding local blocks. */
export function insertRecoveredBlocks(
  current: AnyBlock[],
  snapshot: AnyBlock[],
  fallback: number,
): AnyBlock[] {
  const seen = new Set(current.map((block) => block.ctx.itemId).filter(Boolean));
  let next = current;
  let fallbackAt = fallback;
  for (let start = 0; start < snapshot.length;) {
    const itemId = snapshot[start]!.ctx.itemId;
    let end = start + 1;
    while (end < snapshot.length && snapshot[end]!.ctx.itemId === itemId) end += 1;
    if (itemId && !seen.has(itemId)) {
      const following = snapshot.slice(end).find((block) => seen.has(block.ctx.itemId));
      const preceding = snapshot.slice(0, start).findLast((block) => seen.has(block.ctx.itemId));
      const at = following
        ? next.findIndex((block) => block.ctx.itemId === following.ctx.itemId)
        : preceding
          ? next.findLastIndex((block) => block.ctx.itemId === preceding.ctx.itemId) + 1
          : fallbackAt;
      const added = snapshot.slice(start, end);
      next = [...next.slice(0, at), ...added, ...next.slice(at)];
      seen.add(itemId);
      fallbackAt = at + added.length;
    }
    start = end;
  }
  return next;
}
