// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem } from "@/lib/conversationItems";
import { fetchSessionItemsPage } from "@/lib/sessionsApi";
import {
  galleryAttachmentSource,
  galleryImagesFromItems,
  gallerySwipe,
  loadChatGallery,
} from "./imageGallery";

vi.mock("@/lib/sessionsApi", () => ({ fetchSessionItemsPage: vi.fn() }));
const page = vi.mocked(fetchSessionItemsPage);
const inline = "data:image/png;base64,AAA=";
function message(id: string, content: unknown[]): ConversationItem {
  return {
    id,
    type: "message",
    response_id: id,
    status: "completed",
    role: "user",
    content,
  } as ConversationItem;
}
beforeEach(() => page.mockReset());

describe("authorized message-order gallery inventory", () => {
  it("includes unmounted messages, Markdown and native images in source order", async () => {
    const inventory = await galleryImagesFromItems("chat", [
      message("old", [{ type: "input_image", file_id: "old-image", filename: "old.png" }]),
      message("text", [
        {
          type: "output_text",
          text: "![captured](shots/a.png)\n\n![named][image]\n\n[image]: more/b.svg\n\n```md\n![example](secret.png)\n```",
        },
      ]),
      {
        id: "tool",
        type: "native_tool",
        item: {
          omnigent_attachments: [
            { type: "output_image", file_id: "rendered", filename: "rendered.png" },
          ],
        },
      } as unknown as ConversationItem,
      message("latest", [{ type: "input_image", image_url: inline, filename: "inline.png" }]),
    ]);
    expect(inventory.map((image) => image.itemId)).toEqual([
      "old",
      "text",
      "text",
      "tool",
      "latest",
    ]);
    expect(inventory[0].source).toBe("/v1/sessions/chat/resources/files/old-image/content");
    expect(inventory[1].source).toBe(
      "/v1/sessions/chat/attachments/references/text?path=shots%2Fa.png",
    );
    expect(inventory[4].source).toBe(inline);
    expect(new Set(inventory.map((image) => image.id)).size).toBe(5);
  });
  it("rejects remote tracking, pending/failed files and cross-chat resources", async () => {
    expect(
      galleryAttachmentSource(
        "chat",
        undefined,
        "/v1/sessions/other/resources/files/x/content",
        "m",
      ),
    ).toBeUndefined();
    expect(
      await galleryImagesFromItems("chat", [
        message("m", [
          { type: "input_image", image_url: "https://example.test/tracker.png" },
          { type: "input_image", file_id: "pending:x", filename: "x.png" },
          { type: "output_image", file_id: "failed", error: "denied" },
          {
            type: "input_text",
            text: "![cross](/v1/sessions/other/resources/files/x/content)\n![remote](https://example.test/private.png)",
          },
        ]),
      ]),
    ).toEqual([]);
  });
  it("indexes renderer-approved remote assets without treating them as captured session paths", async () => {
    const asset = "https://github.com/user-attachments/assets/381e47c8-e3f1-4c3e-9b3d-aac5cfb3557b";
    const images = await galleryImagesFromItems("chat", [
      message("remote", [{ type: "output_text", text: `![approved](${asset})` }]),
    ]);
    expect(images.map((image) => image.source)).toEqual([asset]);
    expect(galleryAttachmentSource("chat", { type: "output_image", image_url: asset })).toBe(asset);
    expect(galleryAttachmentSource("chat", undefined, `${asset}?private=1`, "m")).toBeUndefined();
    expect(
      galleryAttachmentSource(
        "chat",
        undefined,
        "https://local.test/v1/sessions/other/resources/files/x/content",
        "m",
      ),
    ).toBeUndefined();
  });
  it("keeps repeated images as distinct message occurrences", async () => {
    const images = await galleryImagesFromItems("chat", [
      message("first", [{ type: "input_image", image_url: inline }]),
      message("second", [{ type: "input_image", image_url: inline }]),
    ]);
    expect(images.map((image) => image.id)).toEqual(["first:0", "second:0"]);
  });
  it("matches captured Markdown path decoding without changing literal-percent filenames", async () => {
    const images = await galleryImagesFromItems("chat", [
      message("paths", [
        {
          type: "output_text",
          text: "![space](shots/a%20b.png) ![percent](shots/a%2520b.png) ![file](file:///old/c%20d.svg)",
        },
      ]),
    ]);
    expect(
      images.map((image) => new URL(image.source, "http://local").searchParams.get("path")),
    ).toEqual(["shots/a b.png", "shots/a%20b.png", "/old/c d.svg"]);
  });
  it("keeps peer and inherited references on the source-item capture endpoint", async () => {
    const inherited = {
      ...message("copied", [{ type: "output_text", text: "![old](snapshots/a.svg)" }]),
      resource_scope: { workspace: { root: "/old/workspace" } },
    };
    const peer = {
      ...message("peer-copy", [{ type: "input_text", text: "![peer](peer/b.png)" }]),
      communication: {
        kind: "peer",
        source_conversation_id: "source-chat",
        destination_conversation_id: "fork-chat",
        message_id: "peer",
        delivery_state: "confirmed",
        source_resource_scope: { workspace: { root: "/peer/workspace" } },
      },
    };
    const images = await galleryImagesFromItems("fork-chat", [inherited, peer]);
    expect(images.map((image) => image.source)).toEqual([
      "/v1/sessions/fork-chat/attachments/references/copied?path=snapshots%2Fa.svg",
      "/v1/sessions/fork-chat/attachments/references/peer-copy?path=peer%2Fb.png",
    ]);
  });
  it("walks bounded older-history pages independently of mounted rows", async () => {
    page.mockResolvedValueOnce({
      items: [message("latest", [{ type: "input_image", file_id: "new" }])],
      hasMore: true,
    });
    page.mockResolvedValueOnce({
      items: [message("oldest", [{ type: "input_image", file_id: "old" }])],
      hasMore: false,
    });
    const signal = new AbortController().signal;
    expect((await loadChatGallery("chat", signal)).map((image) => image.itemId)).toEqual([
      "oldest",
      "latest",
    ]);
    expect(page.mock.calls.map((call) => call[1])).toEqual([
      { olderThan: undefined, limit: 100, signal },
      { olderThan: "latest", limit: 100, signal },
    ]);
  });
  it("rejects a stalled cursor and stops an aborted history scan", async () => {
    page.mockResolvedValue({ items: [message("same", [])], hasMore: true });
    await expect(loadChatGallery("chat", new AbortController().signal)).rejects.toThrow(
      "invalid cursor",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(loadChatGallery("chat", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("fit-only gallery gestures", () => {
  it.each([
    [-80, 10, 1, "next"],
    [80, 10, 1, "previous"],
    [5, 100, 1, "dismiss"],
    [-80, 80, 1, null],
    [40, 5, 1, null],
    [-80, 10, 1.5, null],
    [5, 100, 2, null],
  ])("classifies %s/%s at zoom %s", (dx, dy, zoom, action) =>
    expect(gallerySwipe(dx as number, dy as number, zoom as number)).toBe(action),
  );
});
