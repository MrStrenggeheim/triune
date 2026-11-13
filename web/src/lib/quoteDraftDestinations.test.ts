import { afterEach, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { clearReferenceDrafts, readReferenceDraft } from "./contextReferenceDrafts";
import {
  QUOTE_SUBCHAT_HISTORY_LABEL,
  shouldHideQuoteSubchatHistory,
  serializeContextReference,
  type ContextReference,
} from "./contextReferences";
import { insertQuoteReference, registerQuoteDestination } from "./quoteDraftDestinations";
import { serializeReplyDraft, snapshotReplyDraft, type ReplyDraft } from "./replyDraft";
import { clearSessionDrafts, getSessionDraft, setSessionDraft } from "./sessionDrafts";

const reference: ContextReference = {
  version: 1,
  snapshot_id: "snapshot",
  source_id: "source",
  source_title: "Source conversation",
  destination_id: null,
  scope: "quote",
  boundary_id: "selected-item",
  captured_at: 100,
  items: [{ id: "selected-item", response_id: "response", created_at: 99 }],
  quote: "First line\nSecond line",
  audience: "Visible to everyone with access to the destination",
  representation: "Exact stored items as JSON",
};

it.each([
  ["captured", "captured", true],
  ["captured", "another-item", false],
  ["", "", false],
  [undefined, "captured", false],
] as const)("binds history folding marker %s to branch boundary %s", (marker, boundary, hidden) => {
  expect(
    shouldHideQuoteSubchatHistory(
      marker === undefined ? {} : { [QUOTE_SUBCHAT_HISTORY_LABEL]: marker },
      {
        source_conversation_id: "source",
        source_item_id: boundary,
        reference_only: false,
        inherited_last_item_id: "last-inherited",
        recovery: "replay",
      },
    ),
  ).toBe(hidden);
});

afterEach(() => {
  clearSessionDrafts();
  clearReferenceDrafts();
  useChatStore.setState({ sideChatComposers: {}, sideChatDrafts: {} });
});

it.each(["stored", "side composer"])(
  "preserves %s reply cards, authored whitespace and attachments when inserting an attributed quote",
  (destination) => {
    const files = [new File(["keep"], "attachment.txt")];
    const draft: ReplyDraft = {
      quotes: [{ id: "existing", before: "Introduction", text: "Previous quote" }],
      text: "\nAnswer with > authored text\n\n",
    };
    setSessionDraft("target", {
      text: serializeReplyDraft(draft),
      replyDraft: snapshotReplyDraft(draft),
      files,
    });
    if (destination === "side composer") {
      useChatStore.getState().updateSideChatComposer("target", () => ({ ...draft, files }));
      setSessionDraft("target", { text: "Stale persisted draft", files: [] });
    }
    const send = vi.spyOn(useChatStore.getState(), "send");
    insertQuoteReference("target", reference);
    const next = getSessionDraft("target")!;
    expect(next.text).toContain(serializeReplyDraft(draft));
    expect(next.text).toContain("> First line\n> Second line");
    expect(next.text).not.toMatch(/Open source|snapshot|representation|\{.*version/);
    expect(next.replyDraft?.quotes).toEqual([
      ...snapshotReplyDraft(draft)!.quotes,
      { before: draft.text, text: reference.quote },
    ]);
    expect(next.files).toEqual(files);
    expect(useChatStore.getState().sideChatComposers.target.files).toEqual(files);
    expect(readReferenceDraft("target")).toEqual([reference]);
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  },
);

it("delegates to a mounted composer so its current text, quote cards and files remain authoritative", () => {
  const insert = vi.fn();
  const unregister = registerQuoteDestination("target", insert);
  try {
    setSessionDraft("target", { text: "Stale stored draft", files: [] });
    insertQuoteReference("target", reference);
    expect(insert).toHaveBeenCalledExactlyOnceWith(reference.quote);
    expect(getSessionDraft("target")?.text).toBe("Stale stored draft");
    expect(readReferenceDraft("target")).toEqual([reference]);
  } finally {
    unregister();
  }
});

it("preserves human-authored snapshot-like text literally when adding a quote card", () => {
  const literal = '[Chat context snapshot]\n{"quote":"My example"}\n[/Chat context snapshot]';
  setSessionDraft("target", { text: literal, files: [] });
  insertQuoteReference("target", reference, true);
  expect(getSessionDraft("target")?.replyDraft?.quotes).toEqual([
    { before: literal, text: reference.quote },
  ]);
});

it("uses a mounted composer's structured quote callback without changing its editable text", () => {
  const insert = vi.fn();
  const quote = vi.fn();
  const unregister = registerQuoteDestination("target", insert, quote);
  try {
    insertQuoteReference("target", reference, true);
    insertQuoteReference("target", reference, true);
    expect(quote).toHaveBeenCalledExactlyOnceWith(reference.quote);
    expect(insert).not.toHaveBeenCalled();
    const [saved] = readReferenceDraft("target");
    expect(saved).toEqual({ ...reference, inherited_by: "target" });
    expect(serializeContextReference(saved!)).toBe("");
    expect(saved?.items).toEqual(reference.items);
    expect(saved?.boundary_id).toBe(reference.boundary_id);
    insertQuoteReference("elsewhere", saved!);
    expect(serializeContextReference(readReferenceDraft("elsewhere")[0]!)).toContain(
      "[Chat context snapshot]",
    );
  } finally {
    unregister();
  }
});
