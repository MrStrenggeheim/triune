// Modified for Triune.
import { beforeEach, expect, it, vi } from "vitest";
import { createQuoteSubchat } from "./contextReferenceNavigation";
import { forkSession, getSessionSlim, launchRunner } from "./sessionsApi";

vi.mock("./sessionsApi", () => ({
  forkSession: vi.fn(),
  getSessionSlim: vi.fn(),
  launchRunner: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionSlim).mockResolvedValue({ harness: "claude-sdk" } as Awaited<
    ReturnType<typeof getSessionSlim>
  >);
});
it("creates a durable branch at the captured item without any send or wake", async () => {
  vi.mocked(forkSession).mockResolvedValue({ id: "child" } as Awaited<
    ReturnType<typeof forkSession>
  >);
  expect(
    await createQuoteSubchat({ conversationId: "source", boundaryId: "captured", text: "quote" }),
  ).toBe("child");
  expect(forkSession).toHaveBeenCalledExactlyOnceWith("source", {
    title: "Subchat",
    upToItemId: "captured",
  });
  await expect(
    createQuoteSubchat({ conversationId: "source", boundaryId: "", text: "quote" }),
  ).rejects.toThrow("captured");
  expect(forkSession).toHaveBeenCalledTimes(1);
});

it("initializes an Ask subchat on the source host and retries the same durable child", async () => {
  type Session = Awaited<ReturnType<typeof getSessionSlim>>;
  vi.mocked(getSessionSlim).mockImplementation(
    async (id) =>
      (id === "host-quote"
        ? { hostId: "host", workspace: "/repo", harness: "codex-native" }
        : { id }) as Session,
  );
  vi.mocked(forkSession).mockResolvedValue({ id: "quote-child" } as Session);
  vi.mocked(launchRunner)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ runnerId: "runner" });
  const source = { conversationId: "host-quote", boundaryId: "captured", text: "exact selection" };
  await expect(createQuoteSubchat(source)).rejects.toThrow("quote-child");
  await expect(createQuoteSubchat({ ...source })).resolves.toBe("quote-child");
  expect(forkSession).toHaveBeenCalledExactlyOnceWith("host-quote", {
    title: "Subchat",
    upToItemId: "captured",
  });
  expect(launchRunner).toHaveBeenNthCalledWith(2, "host", "quote-child", "/repo");
});
