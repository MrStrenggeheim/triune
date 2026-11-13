// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import type { NativeToolBlock } from "@/lib/blocks";
import { updateLoadedResourceItems } from "./resourceItemUpdates";

it("never overwrites a newer stream enrichment with a snapshot already in flight", () => {
  const item = {
    id: "dispatch",
    response_id: "turn",
    type: "resource_event",
    resource_type: "session",
    resource_id: "child",
    event_type: "session.subagent.returned",
    resource: {},
  };
  const block: NativeToolBlock = {
    type: "native_tool",
    toolType: "subagent_activity",
    label: "Task",
    data: item,
    ctx: { agent: null, depth: 0, turn: 1, timestamp: 0, responseId: "turn", itemId: "dispatch" },
  };
  const baseline = [block];
  const snapshotItem = { ...item, resource: { task_input: "Captured input" } };
  const streamItem = {
    ...item,
    resource: { task_input: "Captured input", result_text: "New report" },
  };
  const current = updateLoadedResourceItems(baseline, [streamItem]);
  expect(updateLoadedResourceItems(current, [snapshotItem], baseline)).toBe(current);
  expect(current[0]!.ctx).toBe(block.ctx);
  expect((current[0] as NativeToolBlock).data).toBe(streamItem);
});
