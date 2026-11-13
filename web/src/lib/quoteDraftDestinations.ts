// Modified for Triune.

import { readReferenceDraft, writeReferenceDraft } from "./contextReferenceDrafts";
import type { ContextReference } from "./contextReferences";
import { getSessionDraft, setSessionDraft } from "./sessionDrafts";
import { useChatStore } from "@/store/chatStore";
import {
  appendReplyQuote,
  serializeReplyDraft,
  snapshotReplyDraft,
  restoreReplyDraft,
} from "./replyDraft";

const destinations = new Map<
  string,
  { insert: (text: string) => void; quote?: (text: string) => void }
>();
export function registerQuoteDestination(
  id: string,
  insert: (text: string) => void,
  quote?: (text: string) => void,
): () => void {
  const destination = { insert, quote };
  destinations.set(id, destination);
  return () => {
    if (destinations.get(id) === destination) destinations.delete(id);
  };
}
export function appendDraftText(text: string, addition: string): string {
  return text ? `${text}\n\n${addition}\n\n` : `${addition}\n\n`;
}
/** Insert only; this module never sends or changes conversation parentage. */
export function insertQuoteDraft(id: string, text: string, asQuote = false): void {
  const mounted = destinations.get(id);
  if (mounted) {
    (asQuote ? (mounted.quote ?? mounted.insert) : mounted.insert)(text);
    return;
  }
  const existing = getSessionDraft(id);
  const side = useChatStore.getState().sideChatComposers[id];
  const draft = side ?? restoreReplyDraft(existing?.text ?? "", existing?.replyDraft);
  const next = {
    ...(asQuote
      ? appendReplyQuote(draft, text)
      : {
          ...draft,
          quotes: draft.quotes ?? [],
          text: appendDraftText(draft.text, text),
        }),
    files: side?.files ?? existing?.files ?? [],
  };
  setSessionDraft(id, {
    text: serializeReplyDraft(next),
    replyDraft: snapshotReplyDraft(next),
    files: next.files,
  });
  useChatStore.getState().updateSideChatComposer(id, () => next);
}

/** Keep exact context in an inspectable chip and the selected quote readable in the draft. */
export function insertQuoteReference(
  id: string,
  reference: ContextReference,
  inherited = false,
): void {
  const current = readReferenceDraft(id);
  const alreadyInserted = current.some((item) => item.snapshot_id === reference.snapshot_id);
  writeReferenceDraft(id, [
    ...current.filter((item) => item.snapshot_id !== reference.snapshot_id),
    { ...reference, inherited_by: inherited ? id : undefined },
  ]);
  if (reference.quote && !alreadyInserted) insertQuoteDraft(id, reference.quote, true);
}
