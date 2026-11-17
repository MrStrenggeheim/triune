// Modified for Triune.
import { useCallback, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  appendReplyQuote,
  restoreReplyDraft,
  removeReplyQuote,
  moveReplyQuote,
  serializeReplyDraft,
  snapshotReplyDraft,
  type ReplyDraft,
  type StoredReplyDraft,
} from "@/lib/replyDraft";

export function useReplyDraft() {
  const [draft, setDraft] = useState<ReplyDraft>({ quotes: [], text: "" });
  const [activeTextId, focusText] = useState<string | null>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const moves = useRef<{ before: ReplyDraft; after: ReplyDraft }[]>([]);
  const value = draft.quotes.find((quote) => quote.id === activeTextId)?.before ?? draft.text;

  const editText = useCallback((id: string | null, next: SetStateAction<string>) => {
    setDraft((current) => {
      const update = (text: string) => (typeof next === "function" ? next(text) : next);
      return id === null
        ? { ...current, text: update(current.text) }
        : {
            ...current,
            quotes: current.quotes.map((quote) =>
              quote.id === id ? { ...quote, before: update(quote.before) } : quote,
            ),
          };
    });
  }, []);
  const setValue = useCallback(
    (next: SetStateAction<string>) => editText(activeTextId, next),
    [activeTextId, editText],
  );
  const replaceText = useCallback((text: string, saved?: StoredReplyDraft) => {
    moves.current = [];
    setDraft(restoreReplyDraft(text, saved));
    focusText(null);
  }, []);
  const appendQuote = useCallback((text: string) => {
    moves.current = [];
    setDraft((current) => appendReplyQuote(current, text));
    focusText(null);
  }, []);
  const removeQuote = useCallback((id: string) => {
    moves.current = [];
    setDraft((current) => removeReplyQuote(current, id));
    focusText(null);
  }, []);
  const storedReplyDraft = useMemo(() => snapshotReplyDraft(draft), [draft]);
  const moveQuote = useCallback((id: string, targetTextId: string | null, offset: number) => {
    const before = currentDraft.current;
    const after = moveReplyQuote(before, id, targetTextId, offset);
    if (after === before) return;
    moves.current = [...moves.current.slice(-19), { before, after }];
    currentDraft.current = after;
    setDraft(after);
    focusText(id);
  }, []);
  const undoQuoteMove = useCallback(() => {
    const move = moves.current.at(-1);
    if (
      !move ||
      currentDraft.current.quotes.length !== move.after.quotes.length ||
      currentDraft.current.quotes.some(
        (quote, index) => quote.id !== move.after.quotes[index]?.id,
      ) ||
      serializeReplyDraft(currentDraft.current) !== serializeReplyDraft(move.after)
    )
      return false;
    moves.current.pop();
    currentDraft.current = move.before;
    setDraft(move.before);
    focusText(null);
    return true;
  }, []);

  return {
    draft,
    value,
    setValue,
    fullText: serializeReplyDraft(draft),
    storedReplyDraft,
    activeTextId,
    focusText,
    editText,
    replaceText,
    appendQuote,
    removeQuote,
    moveQuote,
    undoQuoteMove,
  };
}
