// Modified for Triune.
import { describe, expect, it } from "vitest";
import {
  readComposerDraft,
  removeReplyQuote,
  moveReplyQuote,
  restoreReplyDraft,
  serializeReplyDraft,
  snapshotReplyDraft,
  type ReplyDraft,
} from "./replyDraft";

const interleaved: ReplyDraft = {
  quotes: [
    { id: "first", before: "Introduction", text: "First line\n\nNext paragraph" },
    { id: "second", before: "First answer", text: "Second quote" },
  ],
  text: "Second answer",
};

describe("reply drafts", () => {
  it("moves an atomic quote into the middle of tail text without changing authored text order", () => {
    const moved = moveReplyQuote(interleaved, "first", null, 7);
    expect(moved.quotes.map((quote) => quote.id)).toEqual(["second", "first"]);
    expect(moved.quotes[0]!.before).toBe("IntroductionFirst answer");
    expect(moved.quotes[1]).toEqual({ ...interleaved.quotes[0], before: "Second " });
    expect(moved.text).toBe("answer");
    expect(interleaved.quotes[0]!.before).toBe("Introduction");
  });

  it("moves backward into an earlier text field and retains Unicode and whitespace", () => {
    const draft: ReplyDraft = {
      quotes: [
        { id: "a", before: "Hi 🙂 world\n", text: "A" },
        { id: "b", before: " B before ", text: "B" },
      ],
      text: " tail",
    };
    const moved = moveReplyQuote(draft, "b", "a", 5);
    expect(moved).toEqual({
      quotes: [
        { id: "b", before: "Hi 🙂", text: "B" },
        { id: "a", before: " world\n", text: "A" },
      ],
      text: " B before  tail",
    });
  });

  it("remaps a removed quote's own and following text fields without losing characters", () => {
    const draft: ReplyDraft = { quotes: [{ id: "a", before: "abc", text: "A" }], text: "def" };
    expect(moveReplyQuote(draft, "a", "a", 1)).toEqual({
      quotes: [{ id: "a", before: "a", text: "A" }],
      text: "bcdef",
    });
    expect(moveReplyQuote(draft, "a", null, 1)).toEqual({
      quotes: [{ id: "a", before: "abcd", text: "A" }],
      text: "ef",
    });
    expect(moveReplyQuote(draft, "a", "a", 3)).toBe(draft);
    expect(moveReplyQuote(draft, "a", "missing", 0)).toBe(draft);
    expect(moveReplyQuote(draft, "missing", null, 0)).toBe(draft);
  });
  it("round-trips explicit interleaved text and multiline quotes without persisting UI ids", () => {
    const text =
      "Introduction\n\n> First line\n> \n> Next paragraph\n\nFirst answer\n\n> Second quote\n\nSecond answer";
    expect(serializeReplyDraft(interleaved)).toBe(text);
    const saved = snapshotReplyDraft(interleaved);
    expect(saved).toEqual({
      version: 1,
      quotes: [
        { before: "Introduction", text: "First line\n\nNext paragraph" },
        { before: "First answer", text: "Second quote" },
      ],
      text: "Second answer",
    });
    const restored = restoreReplyDraft(text, saved);
    expect(snapshotReplyDraft(restored)).toEqual(saved);
    expect(restored.quotes[0]!.id).not.toBe("first");
    expect(restored.quotes[0]!.id).not.toBe(restored.quotes[1]!.id);
    expect(serializeReplyDraft(restored)).toBe(text);
  });

  it.each([
    "",
    "Plain text\n\n",
    "    indented code",
    "prefix > inline text",
    "intro\n> quote\nreply",
    "> quoted\ncontinued",
    "\n\nNotes:\n\n> Example text\n\n\n",
    "Notes:\r\n> Quoted\r\nlazy continuation\r\n",
    "```markdown\n> Example, not a reply\n```",
    "~~~markdown\n~~~~not a closing fence\n> Still a code example",
  ])("keeps unannotated content editable and byte-stable: %j", (text) => {
    expect(readComposerDraft(text)).toEqual({ text });
    expect(restoreReplyDraft(text)).toEqual({ quotes: [], text });
    expect(serializeReplyDraft(restoreReplyDraft(text))).toBe(text);
    expect(snapshotReplyDraft(restoreReplyDraft(text))).toBeUndefined();
  });

  it("keeps explicit cards separate from authored blockquotes and unclosed fences", () => {
    const draft: ReplyDraft = {
      quotes: [
        { id: "a", before: "\nNotes:\n> authored\nlazy continuation\n\n\n", text: "Real quote" },
        { id: "b", before: "~~~markdown\n> code example\n", text: "Another real quote" },
      ],
      text: "\n\n> authored tail\ncontinued\n\n",
    };
    const text = serializeReplyDraft(draft);
    const saved = snapshotReplyDraft(draft);
    const restored = restoreReplyDraft(text, saved);
    expect(snapshotReplyDraft(restored)).toEqual(saved);
    expect(restored.quotes).toHaveLength(2);
    expect(restored.text).toBe(draft.text);
    expect(serializeReplyDraft(restored)).toBe(text);
  });

  it.each([
    undefined,
    null,
    { version: 2, quotes: [{ before: "", text: "Example" }], text: "" },
    { version: 1, quotes: null, text: "" },
    { version: 1, quotes: [null], text: "" },
    { version: 1, quotes: [{ before: 5, text: "Example" }], text: "" },
    { version: 1, quotes: [{ before: "", text: [] }], text: "" },
    { version: 1, quotes: [{ before: "", text: "Example" }], text: null },
    { version: 1, quotes: [{ before: "", text: "Different content" }], text: "" },
  ])(
    "falls back to the original text for invalid or mismatched quote metadata: %j",
    (replyDraft) => {
      const text = "> Example\ncontinued\n\n";
      expect(readComposerDraft({ text, replyDraft })).toEqual({ text });
    },
  );

  it.each([null, [], 1, true, { text: null }, { quotes: [] }])(
    "rejects entries without fallback text: %j",
    (value) => expect(readComposerDraft(value)).toBeUndefined(),
  );

  it("does not accept metadata that disagrees only on authored whitespace", () => {
    const replyDraft = snapshotReplyDraft(interleaved);
    const text = serializeReplyDraft(interleaved) + "\n";
    expect(readComposerDraft({ text, replyDraft })).toEqual({ text });
  });

  it("removes first and final cards without discarding either adjacent text block", () => {
    const removed = removeReplyQuote(interleaved, "first");
    expect(serializeReplyDraft(removed)).toBe(
      "Introduction\n\nFirst answer\n\n> Second quote\n\nSecond answer",
    );
    expect(serializeReplyDraft(removeReplyQuote(removed, "second"))).toBe(
      "Introduction\n\nFirst answer\n\nSecond answer",
    );
  });

  it("preserves all authored text and whitespace when removing actual cards", () => {
    const before = "\nintro\n> authored\nlazy continuation\n\n\n";
    const after = "\n\n> also authored\ncontinued\n";
    const draft: ReplyDraft = {
      quotes: [{ id: "real", before, text: "Selected with Reply" }],
      text: after,
    };
    expect(removeReplyQuote(draft, "real")).toEqual({ quotes: [], text: before + after });
    expect(removeReplyQuote(draft, "missing")).toBe(draft);
  });

  it("does not drop whitespace-only text when removing a card", () => {
    const draft: ReplyDraft = {
      quotes: [{ id: "real", before: "  \n", text: "Selected" }],
      text: "",
    };
    expect(removeReplyQuote(draft, "real")).toEqual({ quotes: [], text: "  \n" });
  });
});
