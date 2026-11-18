// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import { parseEvent } from "./sse";
import type { Bubble } from "./renderItems";
import { mergeStartupInputReceipts, type StartupInputReceipt } from "./startupInputReceipts";

it("keeps stopped and unknown inputs at their original positions until an exact receipt", () => {
  const content = [{ type: "input_text" as const, text: "same text" }];
  const receipts: StartupInputReceipt[] = ["submitted", "waiting2", "waiting1"].map((id, i) => ({
    item_id: id,
    position: 3 - i,
    created_at: 5,
    cancelled_at: 9,
    reason: "stop",
    state: i === 0 ? "delivery_unknown" : "cancelled_before_sending",
    content,
  }));
  const old: Bubble[] = [
    { kind: "user", itemId: "local", pending: true, content, position: 1 },
    { kind: "user", itemId: "submitted", content, position: 3 },
    { kind: "user", itemId: "other", content, position: 4 },
  ];
  const pending = [{ tempId: "local", stableId: "waiting1", content }];
  const view = mergeStartupInputReceipts(old, receipts, pending);
  expect(
    view.map((bubble) => bubble.kind === "user" && [bubble.itemId, bubble.startupReceipt?.state]),
  ).toEqual([
    ["waiting1", "cancelled_before_sending"],
    ["waiting2", "cancelled_before_sending"],
    ["submitted", "delivery_unknown"],
    ["other", undefined],
  ]);
  const confirmed: Bubble[] = [
    { kind: "user", itemId: "other", content, position: 4 },
    { kind: "user", itemId: "native", aliases: ["submitted"], content, position: 5 },
  ];
  const recovered = mergeStartupInputReceipts(confirmed, receipts, []);
  expect(recovered.map((b) => b.kind === "user" && b.itemId)).toEqual([
    "waiting1",
    "waiting2",
    "other",
    "native",
  ]);
});

it("parses the scoped receipt change without treating it as confirmation", () => {
  expect(parseEvent("session.startup_inputs.changed", { conversation_id: "child" })).toEqual({
    type: "startup_input_receipts_changed",
    conversationId: "child",
  });
  expect(parseEvent("session.startup_inputs.changed", {})).toBeNull();
});
