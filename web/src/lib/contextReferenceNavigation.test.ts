// Modified for Triune.
import { beforeEach, expect, it, vi } from "vitest";
import { createQuoteSubchat } from "./contextReferenceNavigation";
import { forkSession, getSessionSlim, launchRunner, updateSession } from "./sessionsApi";
import { QUOTE_SUBCHAT_HISTORY_LABEL } from "./inheritedHistory";

vi.mock("./sessionsApi", () => ({
  forkSession: vi.fn(),
  getSessionSlim: vi.fn(),
  launchRunner: vi.fn(),
  updateSession: vi.fn(),
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

it("awaits marker preparation and the open callback before starting a held launch", async () => {
  type Session = Awaited<ReturnType<typeof getSessionSlim>>;
  vi.mocked(getSessionSlim).mockResolvedValue({
    hostId: "host",
    workspace: "/repo",
    harness: "codex-native",
  } as Session);
  vi.mocked(forkSession).mockResolvedValue({ id: "early-child" } as Session);
  let mark!: (session: Session) => void;
  vi.mocked(updateSession).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        mark = resolve;
      }),
  );
  let opened!: () => void;
  const onCreated = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        opened = resolve;
      }),
  );
  let launch!: (value: { runnerId: string }) => void;
  vi.mocked(launchRunner).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        launch = resolve;
      }),
  );
  const task = createQuoteSubchat(
    { conversationId: "early-source", boundaryId: "captured", text: "quote" },
    onCreated,
  );
  await vi.waitFor(() =>
    expect(updateSession).toHaveBeenCalledWith("early-child", {
      labels: { [QUOTE_SUBCHAT_HISTORY_LABEL]: "captured" },
    }),
  );
  expect(onCreated).not.toHaveBeenCalled();
  expect(launchRunner).not.toHaveBeenCalled();
  mark({ id: "early-child" } as Session);
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith("early-child"));
  expect(launchRunner).not.toHaveBeenCalled();
  opened();
  await vi.waitFor(() => expect(launchRunner).toHaveBeenCalledTimes(1));
  launch({ runnerId: "runner" });
  await expect(task).resolves.toBe("early-child");
  expect(onCreated).toHaveBeenCalledTimes(1);
});

it("retries failed metadata on the same child and does not replay preparation after a launch failure", async () => {
  type Session = Awaited<ReturnType<typeof getSessionSlim>>;
  vi.mocked(getSessionSlim).mockResolvedValue({
    hostId: "host",
    workspace: "/repo",
    harness: "codex-native",
  } as Session);
  vi.mocked(forkSession).mockResolvedValue({ id: "prepared-child" } as Session);
  vi.mocked(updateSession)
    .mockRejectedValueOnce(new Error("Marker unavailable"))
    .mockResolvedValue({ id: "prepared-child" } as Session);
  vi.mocked(launchRunner)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ runnerId: "runner" });
  const source = { conversationId: "prepare-source", boundaryId: "captured", text: "quote" };
  const onCreated = vi.fn();
  await expect(createQuoteSubchat(source, onCreated)).rejects.toThrow("Marker unavailable");
  expect(onCreated).not.toHaveBeenCalled();
  expect(launchRunner).not.toHaveBeenCalled();
  await expect(createQuoteSubchat(source, onCreated)).rejects.toThrow("offline");
  await expect(createQuoteSubchat(source, onCreated)).resolves.toBe("prepared-child");
  expect(forkSession).toHaveBeenCalledTimes(1);
  expect(updateSession).toHaveBeenCalledTimes(2);
  expect(onCreated).toHaveBeenCalledTimes(1);
});
