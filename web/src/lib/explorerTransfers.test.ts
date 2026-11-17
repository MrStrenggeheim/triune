// Modified for Triune.
import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { filesystemOperation } from "./explorerOperations";
import { notify, updateNotification } from "./notifications";
import {
  cancelExplorerTransfer,
  dismissExplorerTransfer,
  getExplorerTransfers,
  startExplorerArchive,
} from "./explorerTransfers";

vi.mock("./explorerOperations", () => ({
  filesystemOperation: vi.fn(),
  downloadBlob: vi.fn(),
  bytesToBase64: vi.fn(),
  childPath: vi.fn(),
}));
vi.mock("./notifications", () => ({
  getNotificationSnapshot: () => ({ entries: [{ id: "transfer" }] }),
  notify: vi.fn(() => "transfer"),
  removeNotification: vi.fn(),
  updateNotification: vi.fn(),
}));

afterEach(() => {
  for (const transfer of getExplorerTransfers()) dismissExplorerTransfer(transfer.conversationId);
  vi.resetAllMocks();
});

it("rejects a transfer without any persisted resource target", () => {
  expect(() => startExplorerArchive(undefined, ["file.txt"])).toThrow(
    "resource target is required",
  );
  expect(filesystemOperation).not.toHaveBeenCalled();
});

it("keeps one notification while ZIP preparation becomes measured download progress", async () => {
  let finishBegin!: (value: { archive_id: string; size: number; filename: string }) => void;
  let finishChunk!: (value: { content_base64: string }) => void;
  vi.mocked(notify).mockReturnValue("transfer");
  vi.mocked(filesystemOperation).mockImplementation(async (_id, body) => {
    if (body.operation === "archive_begin")
      return new Promise((resolve) => {
        finishBegin = resolve;
      });
    if (body.operation === "archive_chunk")
      return new Promise((resolve) => {
        finishChunk = resolve;
      });
    return {};
  });
  startExplorerArchive("zip-chat", ["file.txt"]);
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Preparing ZIP…",
      progress: expect.objectContaining({ active: true, value: undefined, label: undefined }),
    }),
  );
  finishBegin({ archive_id: "archive", size: 3, filename: "bundle.zip" });
  await waitFor(() =>
    expect(updateNotification).toHaveBeenCalledWith(
      "transfer",
      expect.objectContaining({
        title: "Downloading bundle.zip",
        progress: expect.objectContaining({ value: 0 }),
      }),
      expect.any(Object),
    ),
  );
  finishChunk({ content_base64: btoa("zip") });
  await waitFor(() => expect(getExplorerTransfers()[0]?.status).toBe("completed"));
  expect(notify).toHaveBeenCalledOnce();
});

it("keeps independent transfers and cancellation cleanup bound to their initial workspace", async () => {
  let finishBegin!: (value: { archive_id: string; size: number }) => void;
  const operation = vi.mocked(filesystemOperation);
  operation.mockImplementation(async (_sessionId, body) => {
    if (body.operation === "archive_begin")
      return new Promise((resolve) => {
        finishBegin = resolve;
      });
    return {};
  });
  const selected = { id: "workspace-a" };
  startExplorerArchive("same-chat", ["a.txt"], selected);
  cancelExplorerTransfer("workbench-workspace:workspace-a");
  selected.id = "workspace-b";
  finishBegin({ archive_id: "archive-a", size: 0 });
  await waitFor(() => expect(getExplorerTransfers()[0]?.status).toBe("cancelled"));
  expect(operation).toHaveBeenLastCalledWith(
    "same-chat",
    { operation: "archive_cancel", paths: ["a.txt"], archive_id: "archive-a" },
    undefined,
    { id: "workspace-a" },
  );

  operation.mockResolvedValue({ archive_id: "archive-b", size: 0 });
  startExplorerArchive("same-chat", ["b.txt"], selected);
  await waitFor(() => expect(getExplorerTransfers()[1]?.status).toBe("completed"));
  expect(getExplorerTransfers().map((transfer) => transfer.conversationId)).toEqual([
    "workbench-workspace:workspace-a",
    "workbench-workspace:workspace-b",
  ]);
});
