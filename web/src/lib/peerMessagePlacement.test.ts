// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import type { MessageItem } from "./conversationItems";
import { pendingPeerReceiptPlacement, projectPeerReceipts } from "./peerMessagePlacement";

const scope = { server: "server", viewer: "viewer", conversationId: "destination" };
const message = (id: string, position: number): MessageItem => ({
  id,
  position,
  created_at: position + 10,
  type: "message",
  role: "user",
  response_id: "native",
  status: "completed",
  content: [{ type: "input_text", text: "Identical text" }],
});
const peer = (id = "receipt"): MessageItem => ({
  ...message(id, 1),
  response_id: "pending_input",
  status: "incomplete",
  communication: {
    kind: "peer",
    message_id: id,
    destination_conversation_id: "destination",
    source_conversation_id: "source",
    delivery_state: "queued",
    receipt: "accepted",
    reply_to_message_id: "reply-to",
  },
});

it.each([false, true])(
  "keeps one receipt at original placement with echo-first=%s",
  (echoFirst) => {
    const item = peer();
    const later = { ...message("later", 4), role: "assistant" as const };
    const receipt = { scope, item, pendingId: "pending", nativeEchoIds: ["echo", "reply-to"] };
    const initial = echoFirst ? [message("echo", 2), later] : [item, later];
    const projected = projectPeerReceipts(initial, [receipt], scope);
    expect(projected.items.map((entry) => entry.id)).toEqual(["receipt", "later"]);
    expect(projected.items[0]?.created_at).toBe(item.created_at);
    expect(projected.aliases.get("echo")).toBe("receipt");
    expect(projected.aliases.has("reply-to")).toBe(false);
    expect(projected.pendingIds.has("pending")).toBe(true);
    expect(projectPeerReceipts(projected.items, [receipt], scope).items).toEqual(projected.items);
  },
);

it("preserves ordinary identical input, confirmed delivery, and independently scoped views", () => {
  const confirmed = {
    ...peer(),
    response_id: "native",
    status: "completed",
    communication: { ...peer().communication!, delivery_state: "confirmed" as const },
  };
  const ordinary = message("external", 2);
  const items = [confirmed, ordinary, message("other-peer", 3)];
  const receipt = { scope, item: peer(), nativeEchoIds: ["external"] };
  expect(
    projectPeerReceipts(items, [{ ...receipt, scope: { ...scope, viewer: "other" } }], scope).items,
  ).toEqual(items);
  const unbound = projectPeerReceipts(items, [{ scope, item: peer() }], scope);
  expect(unbound.items).toEqual(items);
  expect(unbound.items[0]).toMatchObject({ communication: { delivery_state: "confirmed" } });
  expect(unbound.aliases.has("external")).toBe(false);
});

it("requires canonical receipt identity, scope and positions without moving legacy history", () => {
  const receipt = { scope, item: peer() };
  const legacy = { ...message("legacy", 0), position: undefined };
  expect(projectPeerReceipts([legacy], [receipt], scope)).toMatchObject({
    items: [legacy],
    unplacedReceiptIds: ["receipt"],
  });
  expect(
    projectPeerReceipts([], [{ ...receipt, item: { ...peer(), id: "forged" } }], scope).items,
  ).toEqual([]);
  expect(
    projectPeerReceipts([], [{ ...receipt, scope: { ...scope, conversationId: "other" } }], scope)
      .items,
  ).toEqual([]);
});

it("projects only complete server pending peer identity and never claims consumption", () => {
  const item = peer();
  const snapshot = {
    item_id: item.id,
    position: item.position,
    created_at: item.created_at,
    pending_id: "opaque-acknowledgement",
    communication: item.communication,
    content: item.content,
  };
  const receipt = pendingPeerReceiptPlacement(snapshot, scope)!;
  expect(projectPeerReceipts([], [receipt], scope).items).toEqual([item]);
  expect(pendingPeerReceiptPlacement({ ...snapshot, item_id: undefined }, scope)).toBeUndefined();
  expect(
    pendingPeerReceiptPlacement({ ...snapshot, communication: undefined }, scope),
  ).toBeUndefined();
  expect(
    pendingPeerReceiptPlacement({ ...snapshot, created_at: undefined }, scope),
  ).toBeUndefined();
  const human = { ...message("human", 2), user_authored: true };
  const projected = projectPeerReceipts(
    [human],
    [{ ...receipt, nativeEchoIds: [human.id] }],
    scope,
  );
  expect(projected.items).toContain(human);
  expect(projected.aliases.has(human.id)).toBe(false);
});
