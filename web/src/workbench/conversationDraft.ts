import { getSessionDraft, setSessionDraft } from "@/lib/sessionDrafts";
import { restoreReplyDraft, serializeReplyDraft, snapshotReplyDraft } from "@/lib/replyDraft";
import { useChatStore } from "@/store/chatStore";

/** The full composer already reads primary drafts; carry any older side-pane draft into it. */
export function migrateConversationDraft(conversationId: string, preserveSeed = false): void {
  const store = useChatStore.getState();
  const side = store.sideChatComposers[conversationId];
  const seed = preserveSeed ? undefined : store.sideChatDrafts[conversationId];
  if (!side && !seed) return;
  const primary = getSessionDraft(conversationId);
  const draft = restoreReplyDraft(primary?.text ?? "", primary?.replyDraft);
  const sideDraft = { text: side?.text || seed || "", quotes: side?.quotes ?? [] };
  const sideText = serializeReplyDraft(sideDraft);
  if (sideText && sideText !== primary?.text) {
    if (sideDraft.quotes.length) {
      const [first, ...rest] = sideDraft.quotes;
      draft.quotes.push(
        { ...first, before: [draft.text, first.before].filter(Boolean).join("\n\n") },
        ...rest,
      );
      draft.text = sideDraft.text;
    } else {
      draft.text = [draft.text, sideDraft.text].filter(Boolean).join("\n\n");
    }
  }
  setSessionDraft(conversationId, {
    text: serializeReplyDraft(draft),
    replyDraft: snapshotReplyDraft(draft),
    files: [...new Set([...(primary?.files ?? []), ...(side?.files ?? [])])],
  });
  store.clearSideChatComposer(conversationId);
  if (!preserveSeed) store.clearSideChatDraft(conversationId);
}
