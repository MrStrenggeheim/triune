import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { serializeReplyDraft, type StoredReplyDraft } from "./replyDraft";

const key = "omnigent.sessionDrafts";

describe("session drafts", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
  });
  afterEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("loads legacy string drafts as plain text without inferring cards", async () => {
    const text = "\nintro\n> quote\nlazy continuation\n\n";
    sessionStorage.setItem(key, JSON.stringify({ conversation: text }));
    const { getSessionDraft } = await import("./sessionDrafts");
    expect(getSessionDraft("conversation")).toEqual({ text, files: [] });
  });

  it("persists explicit cards and authored Markdown across a reload", async () => {
    const replyDraft: StoredReplyDraft = {
      version: 1,
      quotes: [{ before: "Notes:\n> authored\ncontinued\n\n\n", text: "Reply selection" }],
      text: "~~~markdown\n> example\n",
    };
    const text = serializeReplyDraft(replyDraft);
    const file = new File(["data"], "notes.txt", { type: "text/plain" });
    const { getSessionDraft, setSessionDraft } = await import("./sessionDrafts");
    setSessionDraft("conversation", { text, replyDraft, files: [file] });
    expect(getSessionDraft("conversation")?.files).toEqual([file]);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
      conversation: { text, replyDraft },
    });

    vi.resetModules();
    const reloaded = await import("./sessionDrafts");
    expect(reloaded.getSessionDraft("conversation")).toEqual({ text, replyDraft, files: [] });
    expect(reloaded.hasSessionDraft("conversation")).toBe(true);
    expect(reloaded.getSessionDraft("another")).toBeUndefined();
  });

  it("preserves fallback text when stored metadata is invalid or unsupported", async () => {
    const text = "> authored\ncontinued\n";
    sessionStorage.setItem(
      key,
      JSON.stringify({
        invalid: { text, replyDraft: { version: 1, quotes: [null], text: "" } },
        newer: { text, replyDraft: { version: 2, quotes: [], text: "" } },
        notText: { text: 42 },
        nullEntry: null,
      }),
    );
    const { getSessionDraft } = await import("./sessionDrafts");
    expect(getSessionDraft("invalid")).toEqual({ text, files: [] });
    expect(getSessionDraft("newer")).toEqual({ text, files: [] });
    expect(getSessionDraft("notText")).toBeUndefined();
    expect(getSessionDraft("nullEntry")).toBeUndefined();
  });

  it.each(["not json", "null", "[]", "42"])("ignores an invalid storage root: %s", async (raw) => {
    sessionStorage.setItem(key, raw);
    const { getSessionDraft } = await import("./sessionDrafts");
    expect(getSessionDraft("conversation")).toBeUndefined();
  });

  it("keeps plain drafts backwards-compatible and removes empty drafts", async () => {
    const { setSessionDraft, hasSessionDraft } = await import("./sessionDrafts");
    setSessionDraft("conversation", { text: "> typed\ncontinued\n", files: [] });
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
      conversation: "> typed\ncontinued\n",
    });
    setSessionDraft("conversation", { text: "", files: [] });
    expect(hasSessionDraft("conversation")).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("recovers a failed temporary draft and ignores its late cleanup write", async () => {
    const { getSessionDraft, recoverFailedSessionDraft, setSessionDraft } =
      await import("./sessionDrafts");
    const originalFile = new File(["initial"], "initial.txt");
    const followUpFile = new File(["follow-up"], "follow-up.txt");
    const temporaryDraft = {
      text: "follow-up typed during startup",
      files: [followUpFile],
    };
    setSessionDraft("temp:failed", temporaryDraft);

    expect(
      recoverFailedSessionDraft(
        { message: "original create prompt", files: [originalFile], project: "docs" },
        "temp:failed",
      ),
    ).toEqual({
      message: "original create prompt\n\nfollow-up typed during startup",
      files: [originalFile, followUpFile],
      project: "docs",
    });
    expect(getSessionDraft("temp:failed")).toBeUndefined();

    setSessionDraft("temp:failed", temporaryDraft);
    expect(getSessionDraft("temp:failed")).toBeUndefined();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("re-renders useSessionDraftIds only when the set of draft ids changes", async () => {
    const { setSessionDraft, useSessionDraftIds } = await import("./sessionDrafts");
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSessionDraftIds();
    });
    expect(result.current).toBe("");

    act(() => setSessionDraft("a", { text: "hi", files: [] }));
    expect(result.current).toBe("a");
    const afterAdd = renders;

    // Editing an existing draft's text leaves the id set unchanged, so no re-render.
    act(() => setSessionDraft("a", { text: "hello again", files: [] }));
    expect(renders).toBe(afterAdd);

    act(() => setSessionDraft("a", { text: "", files: [] }));
    expect(result.current).toBe("");
  });

  it("returns an empty snapshot without subscribing when disabled", async () => {
    const { setSessionDraft, useSessionDraftIds } = await import("./sessionDrafts");
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSessionDraftIds(false);
    });
    const before = renders;

    act(() => setSessionDraft("a", { text: "hi", files: [] }));
    expect(result.current).toBe("");
    expect(renders).toBe(before);
  });
});

// Full payloads live in scoped IndexedDB; legacy sessionStorage remains a text fallback.
describe("durable composer snapshots", () => {
  beforeEach(async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    vi.stubGlobal("indexedDB", new IDBFactory());
    sessionStorage.clear();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("restores files-only snapshots with duplicate names, exact bytes and metadata", async () => {
    const drafts = await import("./sessionDrafts");
    drafts.initializeSessionDraftPersistence("server/alice");
    await drafts.hydrateSessionDraft("chat");
    drafts.setSessionDraft("chat", {
      text: "",
      files: [
        new File([new Uint8Array([0, 255, 1])], "same.txt", {
          type: "application/octet-stream",
          lastModified: 12,
        }),
        new File(["second"], "same.txt", { type: "text/plain", lastModified: 34 }),
      ],
      mentionedItems: [{ path: "src/", isDir: true }],
    });
    await drafts.waitForSessionDraftSave();
    vi.resetModules();
    const fresh = await import("./sessionDrafts");
    fresh.initializeSessionDraftPersistence("server/alice");
    const restored = await fresh.hydrateSessionDraft("chat");
    expect(restored?.text).toBe("");
    expect(restored?.files).toHaveLength(2);
    expect(restored?.files[0]).toMatchObject({
      name: "same.txt",
      type: "application/octet-stream",
      lastModified: 12,
    });
    expect(restored?.files[1]).toMatchObject({
      name: "same.txt",
      type: "text/plain",
      lastModified: 34,
    });
    const { writeComposerDrafts, readComposerDrafts } = await import("./queuedMessagePersistence");
    await writeComposerDrafts("bytes", new Map([["chat", restored!]]));
    const copied = (await readComposerDrafts("bytes")).get("chat")!;
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(copied.files[0]!);
    });
    expect([...new Uint8Array(buffer)]).toEqual([0, 255, 1]);
    expect(restored?.mentionedItems).toEqual([{ path: "src/", isDir: true }]);
  });

  it("preserves quotes/references on promotion and ignores stale hydration after typing/removal", async () => {
    const { writeComposerDrafts, readComposerDrafts } = await import("./queuedMessagePersistence");
    const replyDraft: StoredReplyDraft = {
      version: 1,
      quotes: [{ before: "before", text: "quote" }],
      text: "after",
    };
    const snapshot = {
      text: serializeReplyDraft(replyDraft),
      replyDraft,
      files: [new File(["bytes"], "a.txt")],
      mentionedItems: [{ path: "notes", isDir: false }],
    };
    await writeComposerDrafts(
      "owner",
      new Map([
        ["chat", snapshot],
        ["removed", snapshot],
      ]),
    );
    const drafts = await import("./sessionDrafts");
    drafts.initializeSessionDraftPersistence("owner");
    drafts.setSessionDraft("chat", { text: "newer typing", files: [] });
    drafts.setSessionDraft("removed", { text: "", files: [] });
    await drafts.hydrateSessionDraft("chat");
    expect(drafts.getSessionDraft("chat")?.text).toBe("newer typing");
    expect(drafts.getSessionDraft("removed")).toBeUndefined();
    drafts.setSessionDraft("temp:new", snapshot);
    drafts.promoteSessionDraft("temp:new", "real");
    drafts.setSessionDraft("temp:new", { text: "late cleanup", files: [] });
    await drafts.waitForSessionDraftSave();
    const saved = await readComposerDrafts("owner");
    expect(saved.has("temp:new")).toBe(false);
    expect(saved.get("real")).toMatchObject({
      text: snapshot.text,
      replyDraft,
      mentionedItems: snapshot.mentionedItems,
    });
    expect(saved.get("real")?.files).toHaveLength(1);
  });

  it("promotes the saved bytes when a temporary ID changes before hydration completes", async () => {
    const { writeComposerDrafts, readComposerDrafts } = await import("./queuedMessagePersistence");
    await writeComposerDrafts(
      "owner",
      new Map([
        ["temp:pending", { text: "saved", files: [new File(["retained bytes"], "pending.txt")] }],
      ]),
    );
    const drafts = await import("./sessionDrafts");
    drafts.initializeSessionDraftPersistence("owner");
    drafts.promoteSessionDraft("temp:pending", "real-chat");
    expect((await drafts.hydrateSessionDraft("real-chat"))?.files[0]?.name).toBe("pending.txt");
    expect(drafts.getSessionDraft("temp:pending")).toBeUndefined();
    await drafts.waitForSessionDraftSave();
    const saved = await readComposerDrafts("owner");
    expect(saved.has("temp:pending")).toBe(false);
    expect(saved.get("real-chat")?.files).toHaveLength(1);
  });

  it("rejects another account's late restoration and reports denied storage without claiming success", async () => {
    const drafts = await import("./sessionDrafts");
    drafts.initializeSessionDraftPersistence("alice");
    await drafts.hydrateSessionDraft("chat");
    drafts.setSessionDraft("chat", { text: "alice private", files: [] });
    await drafts.waitForSessionDraftSave();
    drafts.initializeSessionDraftPersistence("bob");
    expect(await drafts.hydrateSessionDraft("chat")).toBeUndefined();
    expect(drafts.getSessionDraft("chat")).toBeUndefined();
    const report = vi.fn();
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("Storage denied");
      },
    });
    drafts.initializeSessionDraftPersistence("denied", report);
    await drafts.hydrateSessionDraft("chat");
    drafts.setSessionDraft("chat", { text: "kept locally", files: [new File(["data"], "a.txt")] });
    await expect(drafts.waitForSessionDraftSave()).rejects.toThrow("Storage denied");
    expect(report).toHaveBeenCalled();
    expect(drafts.getSessionDraft("chat")?.files).toHaveLength(1);
  });
});
