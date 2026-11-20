// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { webcrypto } from "node:crypto";
import type { AnyBlock } from "./blocks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const viewer = vi.hoisted(() => ({ id: "viewer-a" }));
vi.mock("./identity", () => ({ getCurrentUserId: () => viewer.id }));
vi.mock("./host", () => ({ getOmnigentServerIdentity: () => "https://private.example/workspace" }));
vi.mock("./resourceViewStorage", () => ({
  resourceViewStorageScope: () => JSON.stringify(["https://private.example/workspace", viewer.id]),
}));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
  viewer.id = "viewer-a";
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("persists whitelisted received/accepted/displayed generations across reload without content", async () => {
  let diagnostics = await import("./convergenceDiagnostics");
  const detail = {
    conversationId: "chat",
    itemId: "item",
    attemptId: "attempt",
    bindingId: "binding",
    attemptGeneration: 1,
    syncGeneration: 1,
    kind: "item" as const,
    position: 9,
    text: "secret message",
    args: { secret: "argument" },
    url: "https://private.example",
  };
  diagnostics.recordConvergence("received", detail);
  diagnostics.recordConvergence("accepted", detail);
  const captured = diagnostics.readConvergenceIdentity("chat", "item");
  const oldBlock = { type: "text_done", ctx: { itemId: "item" } } as AnyBlock;
  const newBlock = { ...oldBlock };
  diagnostics.stampConvergenceBlocks([oldBlock], captured!);
  diagnostics.stampConvergenceBlocks([newBlock], { ...captured, attemptId: "successor" });
  expect(diagnostics.readBlockConvergenceIdentity(oldBlock)?.attemptId).toBe("attempt");
  expect(diagnostics.readBlockConvergenceIdentity(newBlock)?.attemptId).toBe("successor");
  diagnostics.recordConvergence("accepted", {
    ...detail,
    attemptId: "successor",
    attemptGeneration: 2,
  });
  diagnostics.recordTranscriptDisplayed("chat", { itemId: "item", ...captured });
  await diagnostics.flushConvergenceDiagnostics();
  const encoded = localStorage.getItem(diagnostics.CONVERGENCE_STORAGE_KEY)!;
  expect(encoded).not.toMatch(/secret|argument|https|viewer-a/);
  expect(JSON.parse(encoded).scope).toMatch(/^[a-f0-9]{64}$/);
  vi.resetModules();
  diagnostics = await import("./convergenceDiagnostics");
  await diagnostics.flushConvergenceDiagnostics();
  const records = diagnostics.readConvergenceDiagnostics().records;
  expect(new Set(records.map((record) => record.stage))).toEqual(
    new Set(["received", "accepted", "displayed"]),
  );
  expect(records.find((record) => record.stage === "displayed")).toMatchObject({
    attemptId: "attempt",
    attemptGeneration: 1,
  });
  expect(diagnostics.readConvergenceIdentity("chat", "unknown")).toBeUndefined();
});

it("bounds retention, bytes and alternating hot stages while counting discarded records", async () => {
  const diagnostics = await import("./convergenceDiagnostics");
  for (let index = 0; index < 2000; index++) {
    diagnostics.recordConvergence("received", {
      conversationId: "chat",
      itemId: "hot",
      kind: "delta",
    });
    diagnostics.recordConvergence("accepted", {
      conversationId: "chat",
      itemId: "hot",
      kind: "delta",
    });
  }
  expect(diagnostics.readConvergenceDiagnostics().records).toHaveLength(2);
  for (let index = 0; index < 1000; index++)
    diagnostics.recordConvergence("accepted", {
      conversationId: "chat",
      itemId: `item-${index}`,
      bindingId: "b".repeat(128),
      attemptId: "a".repeat(128),
    });
  await diagnostics.flushConvergenceDiagnostics();
  const value = diagnostics.readConvergenceDiagnostics();
  expect(value.records.length).toBeLessThanOrEqual(diagnostics.CONVERGENCE_MAX_RECORDS);
  expect(value.dropped).toBeGreaterThan(0);
  expect(localStorage.getItem(diagnostics.CONVERGENCE_STORAGE_KEY)!.length * 2).toBeLessThanOrEqual(
    diagnostics.CONVERGENCE_MAX_BYTES,
  );
  vi.setSystemTime(Date.now() + diagnostics.CONVERGENCE_RETENTION_MS + 1);
  expect(diagnostics.readConvergenceDiagnostics().records).toEqual([]);
});

it("fences a delayed digest/write and stale renderer callback across viewer changes", async () => {
  const realDigest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  let finish!: (digest: ArrayBuffer) => void;
  let first = true;
  vi.stubGlobal("crypto", {
    subtle: {
      digest: (algorithm: string, input: BufferSource) => {
        if (!first) return realDigest(algorithm, input);
        first = false;
        return new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const diagnostics = await import("./convergenceDiagnostics");
  diagnostics.recordConvergence("accepted", { conversationId: "old-chat", itemId: "old-item" });
  const oldFlush = diagnostics.flushConvergenceDiagnostics();
  viewer.id = "viewer-b";
  diagnostics.recordConvergence("accepted", { conversationId: "new-chat", itemId: "new-item" });
  await diagnostics.flushConvergenceDiagnostics();
  finish(new ArrayBuffer(32));
  await oldFlush;
  diagnostics.recordTranscriptDisplayed(
    "old-chat",
    { itemId: "old-item" },
    JSON.stringify(["https://private.example/workspace", "viewer-a"]),
  );
  expect(
    diagnostics.readConvergenceDiagnostics().records.map((record) => record.conversationId),
  ).toEqual(["new-chat"]);
  expect(localStorage.getItem(diagnostics.CONVERGENCE_STORAGE_KEY)).not.toContain("old-chat");
});

it("exports individual receipts using opaque identities before local journal coalescing", async () => {
  const send = vi.fn().mockResolvedValue(new Response("{}"));
  vi.doMock("./identity", () => ({ getCurrentUserId: () => viewer.id, authenticatedFetch: send }));
  try {
    const diagnostics = await import("./convergenceDiagnostics");
    diagnostics.configureConvergenceExport(Date.now() + 60000);
    const receipt = { conversationId: "conv", itemId: "synthetic-item", kind: "item" as const };
    diagnostics.recordConvergence("received", receipt);
    // Heartbeats stay out of the upload; they carry no transcript state.
    diagnostics.recordConvergence("received", { conversationId: "conv", kind: "heartbeat" });
    diagnostics.recordConvergence("received", receipt);
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const body = JSON.parse(send.mock.calls[0]![1].body);
    expect(body.records.map((row: { seq: number }) => row.seq)).toEqual([1, 2]);
    expect(body.records[0].item).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(body)).not.toContain("synthetic-item");
    diagnostics.configureConvergenceExport(0);
  } finally {
    vi.doUnmock("./identity");
  }
});
