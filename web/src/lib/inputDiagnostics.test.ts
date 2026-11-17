// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, expect, it, vi } from "vitest";
import { markInputLifecycle } from "./inputDiagnostics";

afterEach(() => vi.unstubAllGlobals());
it("bounds local milestones and excludes invalid identities and content", () => {
  const mark = vi.fn();
  const clearMarks = vi.fn();
  vi.stubGlobal("performance", { mark, clearMarks, getEntriesByName: () => Array(256) });
  markInputLifecycle("accepted", {
    conversationId: "chat-1",
    stableId: "abc123",
    pendingId: "not an identity\nprivate text",
  });
  expect(clearMarks).toHaveBeenCalledWith("triune.input.lifecycle");
  expect(mark).toHaveBeenCalledWith("triune.input.lifecycle", {
    detail: {
      stage: "accepted",
      observedAtMs: expect.any(Number),
      conversationId: "chat-1",
      stableId: "abc123",
    },
  });
});
