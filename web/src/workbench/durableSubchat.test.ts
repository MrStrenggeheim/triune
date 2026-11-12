// Modified for Triune.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forkSession, getSessionSlim, launchRunner } from "@/lib/sessionsApi";
import { clearSessionDrafts, getSessionDraft, setSessionDraft } from "@/lib/sessionDrafts";
import type { Session } from "@/lib/types";
import { openDurableSubchat, subchatBoundary } from "./durableSubchat";

vi.mock("@/lib/sessionsApi", () => ({
  forkSession: vi.fn(),
  getSessionSlim: vi.fn(),
  launchRunner: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(getSessionSlim).mockResolvedValue({ id: "source", harness: "claude-sdk" } as Session);
});
afterEach(() => {
  clearSessionDrafts();
  vi.clearAllMocks();
});
it("forks at the captured boundary immediately, seeds before opening, and rejects duplicate in-flight actions", async () => {
  let finish!: (session: Session) => void;
  vi.mocked(forkSession).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const files = [new File(["notes"], "notes.txt")];
  const draft = { text: "question", files };
  const openConversation = vi.fn((id: string) =>
    expect(getSessionDraft(id)?.text).toBe("question"),
  );
  const request = { sourceId: "source", boundaryId: "captured-item", draft, openConversation };
  const first = openDurableSubchat(request);
  await vi.waitFor(() =>
    expect(forkSession).toHaveBeenCalledExactlyOnceWith("source", {
      title: "Subchat",
      upToItemId: "captured-item",
    }),
  );
  expect(openDurableSubchat(request)).toBeNull();
  draft.text = "newer source edit";
  files.length = 0;
  finish({ id: "child" } as Session);
  await first;
  expect(openConversation).toHaveBeenCalledExactlyOnceWith("child", { beside: true });
  expect(getSessionDraft("child")?.files).toHaveLength(1);
});
it("releases a failed request for retry without opening or seeding a child", async () => {
  vi.mocked(forkSession)
    .mockRejectedValueOnce(new Error("fork denied"))
    .mockResolvedValueOnce({ id: "retry-child" } as Session);
  const openConversation = vi.fn();
  const request = {
    sourceId: "retry-source",
    draft: { text: "keep", files: [] },
    openConversation,
  };
  await expect(openDurableSubchat(request)).rejects.toThrow("fork denied");
  expect(openConversation).not.toHaveBeenCalled();
  expect(getSessionDraft("retry-child")).toBeUndefined();
  await expect(openDurableSubchat(request)).resolves.toBe("retry-child");
});
it("captures the latest persisted source item, excluding live chunks and delegated items", () => {
  expect(
    subchatBoundary([
      { ctx: { depth: 0, itemId: "source-item" } },
      { ctx: { depth: 1, itemId: "delegated-item" } },
      { ctx: { depth: 0, itemId: null } },
    ]),
  ).toBe("source-item");
  expect(subchatBoundary([])).toBeUndefined();
});

it("never sends live previews or synthetic pending/history rows as a fork boundary", () => {
  const synthetic = [
    "live:message",
    "pending:message",
    "temp:message",
    "receipt:user",
    "tool:answer",
  ].map((itemId) => ({ ctx: { depth: 0, itemId } }));
  expect(subchatBoundary([{ ctx: { depth: 0, itemId: "committed-item" } }, ...synthetic])).toBe(
    "committed-item",
  );
  expect(subchatBoundary(synthetic)).toBeUndefined();
});

it("binds host-backed children before opening and keeps a failed child's draft for retry", async () => {
  vi.mocked(getSessionSlim).mockImplementation(
    async (id) =>
      ({
        id,
        harness: "codex-native",
        ...(id === "host-source" ? { hostId: "host", workspace: "/work/tree" } : {}),
      }) as Session,
  );
  vi.mocked(forkSession).mockResolvedValue({ id: "host-child" } as Session);
  vi.mocked(launchRunner)
    .mockRejectedValueOnce(new Error("host offline"))
    .mockResolvedValueOnce({ runnerId: "runner" });
  const openConversation = vi.fn();
  const request = {
    sourceId: "host-source",
    boundaryId: "original",
    draft: { text: "unsent", files: [] },
    openConversation,
  };
  await expect(openDurableSubchat(request)).rejects.toThrow("Retry to reconnect this same subchat");
  expect(launchRunner).toHaveBeenCalledExactlyOnceWith("host", "host-child", "/work/tree");
  expect(openConversation).not.toHaveBeenCalled();
  expect(getSessionDraft("host-child")?.text).toBe("unsent");
  setSessionDraft("host-child", { text: "newer child draft", files: [] });
  await expect(
    openDurableSubchat({ ...request, draft: { text: "newer parent draft", files: [] } }),
  ).resolves.toBe("host-child");
  expect(forkSession).toHaveBeenCalledTimes(1);
  expect(getSessionDraft("host-child")?.text).toBe("newer child draft");
  expect(openConversation).toHaveBeenCalledExactlyOnceWith("host-child", { beside: true });
});

it("reconciles a lost launch response without launching or forking again", async () => {
  vi.mocked(getSessionSlim)
    .mockResolvedValueOnce({ hostId: "host", workspace: "/work", harness: "pi" } as Session)
    .mockResolvedValueOnce({
      id: "bound-child",
      runnerId: "runner",
      workspace: "/work",
    } as Session);
  vi.mocked(forkSession).mockResolvedValue({ id: "bound-child" } as Session);
  vi.mocked(launchRunner).mockRejectedValueOnce(new Error("response lost"));
  const request = {
    sourceId: "lost-source",
    draft: { text: "question", files: [] },
    openConversation: vi.fn(),
  };
  await expect(openDurableSubchat(request)).rejects.toThrow("response lost");
  await expect(openDurableSubchat(request)).resolves.toBe("bound-child");
  expect(forkSession).toHaveBeenCalledTimes(1);
  expect(launchRunner).toHaveBeenCalledTimes(1);
});

it("waits for host initialization while retaining the unsent draft", async () => {
  vi.mocked(getSessionSlim).mockResolvedValue({
    hostId: "host",
    workspace: "/work",
    harness: "claude-native",
  } as Session);
  vi.mocked(forkSession).mockResolvedValue({ id: "connecting-child" } as Session);
  let connect!: (value: { runnerId: string }) => void;
  vi.mocked(launchRunner).mockImplementation(
    () =>
      new Promise((resolve) => {
        connect = resolve;
      }),
  );
  const openConversation = vi.fn();
  const task = openDurableSubchat({
    sourceId: "connecting-source",
    draft: { text: "retained", files: [] },
    openConversation,
  });
  await vi.waitFor(() => expect(launchRunner).toHaveBeenCalled());
  expect(getSessionDraft("connecting-child")?.text).toBe("retained");
  expect(openConversation).not.toHaveBeenCalled();
  connect({ runnerId: "runner" });
  await task;
  expect(openConversation).toHaveBeenCalledWith("connecting-child", { beside: true });
});

it("explains missing host recovery before creating an unusable native child", async () => {
  vi.mocked(getSessionSlim).mockResolvedValue({
    workspace: "/local",
    harness: "codex-native",
  } as Session);
  await expect(
    openDurableSubchat({
      sourceId: "local-source",
      draft: { text: "keep", files: [] },
      openConversation: vi.fn(),
    }),
  ).rejects.toThrow("Reconnect the source conversation");
  expect(forkSession).not.toHaveBeenCalled();
});
