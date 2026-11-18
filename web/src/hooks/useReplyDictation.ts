// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { ReplyQuote } from "@/lib/replyDraft";
import { useDictationInsert } from "./useDictationInsert";

interface VoiceDraft {
  text: string;
  quotes?: ReplyQuote[];
}
interface DictatedField {
  before: string;
  after: string;
  quoteIds: Set<string>;
}

/** Discard only dictated text still owned by the recording, even after focus changes. */
export function useReplyDictation(
  owner: string | null,
  draft: VoiceDraft,
  activeId: string | null,
  edit: (id: string | null, next: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
) {
  const edits = useRef(new Map<string | null, DictatedField>());
  const current = useRef(draft);
  current.current = draft;
  useLayoutEffect(() => {
    edits.current.clear();
  }, [owner]);
  const reconcile = useCallback(() => {
    const { quotes, text } = current.current;
    for (const [id, change] of edits.current) {
      const field = id ?? quotes?.find((quote) => !change.quoteIds.has(quote.id))?.id ?? null;
      const value = field === null ? text : quotes?.find((quote) => quote.id === field)?.before;
      if (value !== change.after || field !== id) edits.current.delete(id);
      if (value === change.after && field !== id) edits.current.set(field, change);
    }
  }, []);
  useLayoutEffect(reconcile, [draft.text, draft.quotes, reconcile]);
  const value = draft.quotes?.find((quote) => quote.id === activeId)?.before ?? draft.text;
  const insert = useDictationInsert(
    value,
    (next) => {
      reconcile();
      const latest = current.current;
      const before =
        activeId === null
          ? latest.text
          : latest.quotes?.find((quote) => quote.id === activeId)?.before;
      if (before === undefined) return;
      const previous = edits.current.get(activeId);
      edits.current.set(activeId, {
        before: previous?.before ?? before,
        after: next,
        quoteIds: previous?.quoteIds ?? new Set(latest.quotes?.map((q) => q.id)),
      });
      edit(activeId, next);
    },
    input,
  );
  return {
    ...insert,
    begin: () => edits.current.clear(),
    discard: () => {
      reconcile();
      for (const [id, change] of edits.current) edit(id, change.before);
      edits.current.clear();
    },
  };
}
