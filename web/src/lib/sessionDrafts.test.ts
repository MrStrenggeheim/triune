// Modified for Triune.
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

  it("restores a complete file draft over its text-only reload fallback", async () => {
    const drafts = await import("./sessionDrafts");
    drafts.initializeSessionDraftPersistence("owner");
    await drafts.waitForSessionDraftSave();
    drafts.setSessionDraft("chat", {
      text: "Keep text and files together",
      files: [new File(["exact bytes"], "alpha.txt", { type: "text/plain" })],
      mentionedItems: [{ path: "notes", isDir: false }],
    });
    await drafts.waitForSessionDraftSave();
    expect(sessionStorage.getItem(key)).toContain("Keep text and files together");
    vi.resetModules();
    const reloaded = await import("./sessionDrafts");
    expect(reloaded.getSessionDraft("chat")?.files).toHaveLength(0);
    reloaded.initializeSessionDraftPersistence("owner");
    const hydrated = await reloaded.hydrateSessionDraft("chat");
    expect(hydrated?.text).toBe("Keep text and files together");
    expect(hydrated?.files[0]).toMatchObject({ name: "alpha.txt", type: "text/plain" });
    expect(hydrated?.mentionedItems).toEqual([{ path: "notes", isDir: false }]);
  });

  it("does not revive a deleted durable draft from stale legacy text", async () => {
    const api = await import("./queuedMessagePersistence");
    await api.writeComposerDrafts("owner", new Map());
    sessionStorage.setItem(key, JSON.stringify({ removed: "Stale fallback" }));
    sessionStorage.setItem(`${key}.scope`, "owner");
    const drafts = await import("./sessionDrafts");
    drafts.initializeSessionDraftPersistence("owner");
    await drafts.waitForSessionDraftSave();
    expect(drafts.getSessionDraft("removed")).toBeUndefined();
    expect(await api.readComposerDrafts("owner")).toEqual(new Map());
  });

  it("migrates legacy text when there is no durable snapshot", async () => {
    sessionStorage.setItem(key, JSON.stringify({ legacy: "Preserve old installations" }));
    const drafts = await import("./sessionDrafts");
    drafts.initializeSessionDraftPersistence("owner");
    await drafts.waitForSessionDraftSave();
    const api = await import("./queuedMessagePersistence");
    expect((await api.readComposerDrafts("owner")).get("legacy")?.text).toBe(
      "Preserve old installations",
    );
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
    const coverage = renderHook(() => drafts.useSessionDraftsHydrated());
    expect(coverage.result.current).toBe(true);
    act(() => drafts.initializeSessionDraftPersistence("alice"));
    expect(coverage.result.current).toBe(false);
    await act(() => drafts.hydrateSessionDraft("chat"));
    expect(coverage.result.current).toBe(true);
    drafts.setSessionDraft("chat", { text: "alice private", files: [] });
    await drafts.waitForSessionDraftSave();
    act(() => drafts.initializeSessionDraftPersistence("bob"));
    await act(async () => expect(await drafts.hydrateSessionDraft("chat")).toBeUndefined());
    expect(drafts.getSessionDraft("chat")).toBeUndefined();
    const report = vi.fn();
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("Storage denied");
      },
    });
    act(() => drafts.initializeSessionDraftPersistence("denied", report));
    await act(() => drafts.hydrateSessionDraft("chat"));
    expect(coverage.result.current).toBe(false);
    drafts.setSessionDraft("chat", { text: "kept locally", files: [new File(["data"], "a.txt")] });
    await expect(drafts.waitForSessionDraftSave()).rejects.toThrow("Storage denied");
    expect(report).toHaveBeenCalled();
    expect(drafts.getSessionDraft("chat")?.files).toHaveLength(1);
  });

  it("keeps unread files and rejects saving after failed hydration becomes writable", async () => {
    const api = await import("./queuedMessagePersistence");
    await api.writeComposerDrafts(
      "owner",
      new Map([["old", { text: "saved", files: [new File(["old bytes"], "old.txt")] }]]),
    );
    const database = indexedDB;
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("Read denied");
      },
    });
    const drafts = await import("./sessionDrafts");
    const error = vi.fn();
    drafts.initializeSessionDraftPersistence("owner", error);
    await drafts.hydrateSessionDraft("new");
    vi.stubGlobal("indexedDB", database);
    const local = { text: "typing", files: [new File(["local bytes"], "new.txt")] };
    drafts.setSessionDraft("new", local);
    await expect(drafts.waitForSessionDraftSave()).rejects.toThrow("Read denied");
    const saved = await api.readComposerDrafts("owner");
    expect([...saved.keys()]).toEqual(["old"]);
    const buffer = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(saved.get("old")!.files[0]);
    });
    expect(buffer).toBe("old bytes");
    expect(drafts.getSessionDraft("new")).toEqual(local);
    expect(error).toHaveBeenCalledOnce();
  });

  it("atomically preserves independent drafts and files without resurrecting deletions", async () => {
    const api = await import("./queuedMessagePersistence");
    await api.writeComposerDrafts(
      "owner",
      new Map([["removed", { text: "old", files: [new File(["old bytes"], "old.txt")] }]]),
    );
    const first = await import("./sessionDrafts");
    first.initializeSessionDraftPersistence("owner");
    await first.waitForSessionDraftSave();
    sessionStorage.clear();
    vi.resetModules();
    const second = await import("./sessionDrafts");
    second.initializeSessionDraftPersistence("owner");
    await second.waitForSessionDraftSave();
    first.setSessionDraft("first", {
      text: "first draft",
      files: [new File(["first bytes"], "same.txt")],
    });
    second.setSessionDraft("second", {
      text: "second draft",
      files: [new File(["second bytes"], "same.txt")],
    });
    await Promise.all([first.waitForSessionDraftSave(), second.waitForSessionDraftSave()]);
    let saved = await api.readComposerDrafts("owner");
    expect([...saved.keys()].sort()).toEqual(["first", "removed", "second"]);
    const contents = (file: File) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      });
    expect(await contents(saved.get("first")!.files[0])).toBe("first bytes");
    expect(await contents(saved.get("second")!.files[0])).toBe("second bytes");
    first.setSessionDraft("removed", { text: "", files: [] });
    await first.waitForSessionDraftSave();
    second.setSessionDraft("second", {
      text: "new second text",
      files: second.getSessionDraft("second")!.files,
    });
    await second.waitForSessionDraftSave();
    saved = await api.readComposerDrafts("owner");
    expect(saved.has("removed")).toBe(false);
    expect(saved.get("second")?.text).toBe("new second text");
    second.setSessionDraft("removed", {
      text: "stale edit",
      files: [new File(["local bytes"], "local.txt")],
    });
    await expect(second.waitForSessionDraftSave()).rejects.toThrow("removed by another client");
    expect((await api.readComposerDrafts("owner")).has("removed")).toBe(false);
    expect(second.getSessionDraft("removed")?.text).toBe("stale edit");
    second.initializeSessionDraftPersistence("other");
    await second.waitForSessionDraftSave();
    second.initializeSessionDraftPersistence("owner");
    await expect(second.waitForSessionDraftSave()).rejects.toThrow("removed by another client");
    expect((await api.readComposerDrafts("owner")).has("removed")).toBe(false);
    expect(second.getSessionDraft("removed")?.text).toBe("stale edit");
  });

  it.each(["server-a/bob", "server-b/alice"])(
    "preserves outgoing hydration edits and files privately when switching to %s",
    async (other) => {
      const api = await import("./queuedMessagePersistence");
      const owner = "server-a/alice";
      await api.writeComposerDrafts(
        owner,
        new Map([["chat", { text: "old", files: [new File(["old bytes"], "old.txt")] }]]),
      );
      const drafts = await import("./sessionDrafts");
      drafts.initializeSessionDraftPersistence(owner);
      const local = { text: "new typing", files: [new File(["new bytes"], "new.txt")] };
      drafts.setSessionDraft("chat", local);
      drafts.initializeSessionDraftPersistence(other);
      expect(drafts.getSessionDraft("chat")).toBeUndefined();
      await drafts.waitForSessionDraftSave();
      expect(drafts.getSessionDraft("chat")).toBeUndefined();
      expect(await api.readComposerDrafts(other)).toEqual(new Map());
      drafts.initializeSessionDraftPersistence(owner);
      expect(drafts.getSessionDraft("chat")?.text).toBe(local.text);
      const restored = await drafts.hydrateSessionDraft("chat");
      expect(restored?.text).toBe(local.text);
      expect(restored?.files[0].name).toBe("new.txt");
      const reader = new FileReader();
      const bytes = new Promise((resolve) => {
        reader.onload = () => resolve(reader.result);
      });
      reader.readAsText(restored!.files[0]);
      expect(await bytes).toBe("new bytes");
    },
  );

  it.each(["remove", "clear", "promote"])(
    "retains %s during hydration through an immediate scope return",
    async (action) => {
      const api = await import("./queuedMessagePersistence");
      await api.writeComposerDrafts(
        "alice",
        new Map([
          ["temp:source", { text: "saved", files: [new File(["saved bytes"], "saved.txt")] }],
        ]),
      );
      const drafts = await import("./sessionDrafts");
      drafts.initializeSessionDraftPersistence("alice");
      if (action === "remove") drafts.setSessionDraft("temp:source", { text: "", files: [] });
      if (action === "clear") drafts.clearSessionDrafts();
      if (action === "promote") drafts.promoteSessionDraft("temp:source", "real");
      drafts.initializeSessionDraftPersistence("bob");
      drafts.initializeSessionDraftPersistence("alice");
      await drafts.waitForSessionDraftSave();
      expect(drafts.getSessionDraft("temp:source")).toBeUndefined();
      const saved = await api.readComposerDrafts("alice");
      expect([...saved.keys()]).toEqual(action === "promote" ? ["real"] : []);
      if (action === "promote") expect(saved.get("real")?.files[0].name).toBe("saved.txt");
      expect(await api.readComposerDrafts("bob")).toEqual(new Map());
    },
  );

  it("retains failed-hydration edits and files privately until explicit return and recovery", async () => {
    const api = await import("./queuedMessagePersistence");
    await api.writeComposerDrafts("alice", new Map([["old", { text: "saved", files: [] }]]));
    const database = indexedDB;
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("Offline");
      },
    });
    const drafts = await import("./sessionDrafts");
    drafts.initializeSessionDraftPersistence("alice");
    await drafts.hydrateSessionDraft("chat");
    const local = { text: "typing", files: [new File(["local bytes"], "local.txt")] };
    drafts.setSessionDraft("chat", local);
    drafts.initializeSessionDraftPersistence("bob");
    await drafts.hydrateSessionDraft("chat");
    expect(drafts.getSessionDraft("chat")).toBeUndefined();
    vi.stubGlobal("indexedDB", database);
    drafts.initializeSessionDraftPersistence("alice");
    expect(drafts.getSessionDraft("chat")).toBe(local);
    await drafts.waitForSessionDraftSave();
    const saved = await api.readComposerDrafts("alice");
    expect([...saved.keys()].sort()).toEqual(["chat", "old"]);
    expect(saved.get("chat")?.files[0].name).toBe("local.txt");
    expect(await api.readComposerDrafts("bob")).toEqual(new Map());
  });

  it("keeps a late outgoing file failure with its owner and saves the new identity successfully", async () => {
    const drafts = await import("./sessionDrafts");
    const report = vi.fn();
    drafts.initializeSessionDraftPersistence("alice", report);
    await drafts.waitForSessionDraftSave();
    let fail: (error: Error) => void = () => {
      throw new Error("No pending file read");
    };
    let started: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const file = new File(["bytes"], "local.txt");
    Object.defineProperty(file, "arrayBuffer", {
      value: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
          started();
        }),
    });
    drafts.setSessionDraft("chat", { text: "unsaved", files: [file] });
    await reading;
    const oldSave = drafts.waitForSessionDraftSave();
    drafts.initializeSessionDraftPersistence("bob", report);
    fail(new Error("Attachment read failed"));
    await expect(oldSave).rejects.toThrow("identity changed");
    await drafts.waitForSessionDraftSave();
    expect(report).not.toHaveBeenCalled();
    expect(drafts.getSessionDraft("chat")).toBeUndefined();
    drafts.initializeSessionDraftPersistence("alice", report);
    expect(drafts.getSessionDraft("chat")?.files).toEqual([file]);
    // A replacement is an explicit edit; no background retry reads the failed file.
    drafts.setSessionDraft("chat", {
      text: "unsaved",
      files: [new File(["replacement bytes"], "fixed.txt")],
    });
    await drafts.waitForSessionDraftSave();
    expect(drafts.getSessionDraft("chat")?.files[0].name).toBe("fixed.txt");
  });
});
