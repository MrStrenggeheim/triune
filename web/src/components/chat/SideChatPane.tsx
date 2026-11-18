// Modified for Triune.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { MessagesSquareIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/hooks/useSession";
import { useConversationEntryState } from "@/hooks/useConversationEntryState";
import { useAutoGrowTextarea } from "@/hooks/useAutoGrowTextarea";
import { useReplyDictation } from "@/hooks/useReplyDictation";
import { toast } from "@/lib/notifications";
import { clipboardFiles } from "@/lib/attachments";
import {
  appendReplyQuote,
  removeReplyQuote,
  moveReplyQuote,
  serializeReplyDraft,
  type ReplyDraft,
} from "@/lib/replyDraft";
import { registerQuoteDestination, appendDraftText } from "@/lib/quoteDraftDestinations";
import { isSlashCommandText } from "@/components/SlashCommandMenu";
import {
  ChatComposer,
  ComposerSendButton,
  type ComposerKeyIntent,
} from "@/components/composer/ChatComposer";
import { ComposerMicButton } from "@/components/ComposerMicButton";
import { ReplyDraftBlocks } from "@/components/composer/ReplyDraftBlocks";
import { SelectionPopup } from "./SelectionPopup";
import { WorkingIndicator } from "./chatBubbleParts";
import { ConversationScopeContext, EmbeddedChatContext } from "./conversationScope";
import { ScopedConversationSurface } from "@/workbench/ScopedConversationSurface";
import { ScopedConversationTerminal } from "@/workbench/ScopedConversationTerminal";
import { ScopedChatStoreProvider } from "@/workbench/ScopedChatStore";
import { ComposerShelfVisibilityProvider } from "@/components/composer/ComposerShelfVisibility";
import { useChatStore, EMPTY_SIDE_CHAT_COMPOSER } from "@/store/chatStore";

interface SideChatPaneProps {
  childId: string;
  selectionParentId?: string;
  onStart?: (text: string) => Promise<void>;
  readOnly?: boolean;
  fullSession?: boolean;
  visible?: boolean;
  focused?: boolean;
}

export function SideChatPane({
  childId,
  selectionParentId,
  onStart,
  readOnly = false,
  fullSession = false,
  visible = true,
  focused = visible,
}: SideChatPaneProps) {
  const pending = childId.startsWith("pending:");
  const starting = useChatStore((s) => s.sideChatComposers[childId]?.starting ?? false);
  const { session } = useSession(pending || !visible ? null : childId);
  const sealed = session?.labels?.["omnigent.closed"] === "true";
  const reason =
    sealed || (readOnly && !fullSession)
      ? "This side chat has ended and can’t be continued."
      : readOnly
        ? "You have read-only access to this session"
        : null;
  const presentation = useMemo(
    () => ({ subchat: !fullSession, readOnlyReason: reason }),
    [fullSession, reason],
  );
  useLayoutEffect(() => {
    if (!visible || !selectionParentId || reason || starting) return;
    const target = { childId, parentId: selectionParentId };
    useChatStore.setState({ sideChatSelectionTarget: target });
    return () => {
      if (useChatStore.getState().sideChatSelectionTarget === target)
        useChatStore.setState({ sideChatSelectionTarget: null });
    };
  }, [visible, childId, selectionParentId, reason, starting]);
  if (pending)
    return (
      <PendingSubchat
        key={childId}
        childId={childId}
        starting={starting}
        readOnly={readOnly}
        onStart={onStart}
      />
    );
  return (
    <ScopedChatStoreProvider
      key={childId}
      conversationId={childId}
      visible={visible}
      focused={focused}
    >
      <ConversationScopeContext.Provider value={childId}>
        <EmbeddedChatContext.Provider value={presentation}>
          <ComposerShelfVisibilityProvider>
            <ScopedConversationTerminal conversationId={childId} chatOnly>
              {visible && !fullSession && !reason && session && session.permissionLevel !== 1 && (
                <SeededSubchatSend conversationId={childId} />
              )}
              <ScopedConversationSurface
                conversationId={childId}
                visible={visible}
                preserveSeed={!fullSession}
              />
            </ScopedConversationTerminal>
          </ComposerShelfVisibilityProvider>
        </EmbeddedChatContext.Provider>
      </ConversationScopeContext.Provider>
    </ScopedChatStoreProvider>
  );
}

/** Claim the first /side question only when its child can accept it. */
function SeededSubchatSend({ conversationId }: { conversationId: string }) {
  const seed = useChatStore((s) => s.sideChatDrafts[conversationId]);
  const agentId = useConversationEntryState(conversationId, (s) => s.boundAgentId);
  const loading = useConversationEntryState(conversationId, (s) => s.loadingConversation);
  const queryClient = useQueryClient();
  useEffect(() => {
    const store = useChatStore.getState();
    if (!seed || !agentId || loading || store.sideChatDrafts[conversationId] !== seed) return;
    store.clearSideChatDraft(conversationId);
    void store
      .send(seed, agentId, undefined, { pinnedConversationId: conversationId })
      .finally(() => queryClient.invalidateQueries({ queryKey: ["session", conversationId] }));
  }, [conversationId, seed, agentId, loading, queryClient]);
  return null;
}

function PendingSubchat({
  childId,
  starting,
  readOnly,
  onStart,
}: Pick<SideChatPaneProps, "childId" | "onStart" | "readOnly"> & { starting: boolean }) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composer = useChatStore((s) => s.sideChatComposers[childId]);
  const text = composer?.text ?? "";
  const updateComposer = useChatStore((s) => s.updateSideChatComposer);
  const clearSideChatDraft = useChatStore((s) => s.clearSideChatDraft);
  const setText = useCallback(
    (next: string) => updateComposer(childId, (current) => ({ ...current, text: next })),
    [childId, updateComposer],
  );
  const [activeTextId, setActiveTextId] = useState<string | null>(null);
  const editText = useCallback(
    (id: string | null, next: string) =>
      updateComposer(childId, (current) =>
        id === null
          ? { ...current, text: next }
          : {
              ...current,
              quotes: current.quotes?.map((quote) =>
                quote.id === id ? { ...quote, before: next } : quote,
              ),
            },
      ),
    [childId, updateComposer],
  );

  const tailTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(
    () =>
      registerQuoteDestination(
        childId,
        (addition) => {
          updateComposer(childId, (current) => ({
            ...current,
            text: appendDraftText(current.text, addition),
          }));
          tailTextareaRef.current?.focus();
        },
        (quote) =>
          updateComposer(childId, (current) => ({
            ...current,
            ...appendReplyQuote(current, quote),
          })),
      ),
    [childId, updateComposer],
  );
  const dictation = useReplyDictation(
    childId,
    composer ?? EMPTY_SIDE_CHAT_COMPOSER,
    activeTextId,
    editText,
    textareaRef,
  );
  const quote = useChatStore((s) => s.sideChatDrafts[childId]);
  const quotes = [
    ...(quote === undefined ? [] : [{ id: "seed", before: "", text: quote }]),
    ...(composer?.quotes ?? []),
  ];
  const quoteMoves = useRef<{
    childId: string;
    moves: { before: ReplyDraft; after: ReplyDraft }[];
  }>({ childId, moves: [] });
  if (quoteMoves.current.childId !== childId) quoteMoves.current = { childId, moves: [] };
  useAutoGrowTextarea(tailTextareaRef, text, quotes.length ? Infinity : 10);
  useEffect(() => {
    setActiveTextId(null);
    textareaRef.current = tailTextareaRef.current;
    if (quote !== undefined || composer?.quotes?.length) tailTextareaRef.current?.focus();
  }, [quote, composer?.quotes?.length]);

  const ready = !starting && !readOnly;
  const canSend = serializeReplyDraft({ quotes, text }).trim().length > 0;
  const submit = async () => {
    if (
      !canSend ||
      !ready ||
      !onStart ||
      useChatStore.getState().sideChatComposers[childId]?.starting
    )
      return;
    updateComposer(childId, (current) => ({ ...current, starting: true }));
    try {
      await onStart(
        serializeReplyDraft({
          quotes,
          text: isSlashCommandText(text) ? text.trim() : text.trimEnd(),
        }),
      );
      clearSideChatDraft(childId);
      useChatStore.getState().clearSideChatComposer(childId);
    } catch (error) {
      updateComposer(childId, (current) => ({ ...current, starting: false }));
      toast.error(error instanceof Error ? error.message : "Couldn’t create this subchat.");
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!clipboardFiles(event.clipboardData).length) return;
    event.preventDefault();
    toast.error("Send a text question to start the side chat before attaching files.");
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, intent: ComposerKeyIntent) => {
    if (intent.shouldSubmitFromKeyboard) {
      event.preventDefault();
      void submit();
    }
  };
  const focusText = (id: string | null, input: HTMLTextAreaElement) => {
    setActiveTextId(id);
    textareaRef.current = input;
    dictation.noteFocus();
  };

  return (
    <div className="side-chat-backdrop flex h-full min-h-0 flex-col">
      <div
        ref={transcriptRef}
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <MessagesSquareIcon className="size-6 text-muted-foreground" />
        <p className="text-ui font-medium text-foreground">Side chat</p>
        <p className="max-w-[36ch] text-sm text-muted-foreground">
          Ask a question here without affecting the main conversation.
        </p>
      </div>
      {ready && (
        <SelectionPopup
          containerRef={transcriptRef}
          onReply={(selected) =>
            updateComposer(childId, (current) => ({
              ...current,
              ...appendReplyQuote(current, selected),
            }))
          }
        />
      )}
      <div className="composer-shelf-stack shrink-0 px-3 pt-3 pb-5">
        {starting && (
          <ConversationScopeContext.Provider value={childId}>
            <WorkingIndicator />
          </ConversationScopeContext.Provider>
        )}
        <ChatComposer
          keyboard={{ submitWithModEnter: false, preventsKeyboardSubmit: false }}
          input={{
            ref: tailTextareaRef,
            value: text,
            onChange: (e) => setText(e.target.value),
            onFocus: (e) => focusText(null, e.currentTarget),
            placeholder: "Ask a side question...",
            disabled: !ready,
            "data-testid": "side-chat-input",
            onKeyDown: handleKeyDown,
            onPaste,
            className: quotes.length ? "max-h-none overflow-y-hidden" : undefined,
          }}
          slots={{
            inputPrefix:
              quotes.length === 0 ? undefined : (
                <ReplyDraftBlocks
                  quotes={quotes}
                  activeTextId={activeTextId}
                  keyboard={{ submitWithModEnter: false, preventsKeyboardSubmit: false }}
                  disabled={!ready}
                  onMove={(id, target, offset) => {
                    const before = { quotes, text };
                    const after = moveReplyQuote(before, id, target, offset);
                    if (before === after) return;
                    quoteMoves.current.moves = [
                      ...quoteMoves.current.moves.slice(-19),
                      { before, after },
                    ];
                    updateComposer(childId, (current) => ({ ...current, ...after }));
                    if (quote !== undefined) clearSideChatDraft(childId);
                    setActiveTextId(id);
                  }}
                  onUndoMove={() => {
                    const move = quoteMoves.current.moves.at(-1);
                    const current = useChatStore.getState().sideChatComposers[childId];
                    if (
                      !move ||
                      !current ||
                      current.quotes?.length !== move.after.quotes.length ||
                      current.quotes.some(
                        (item, index) => item.id !== move.after.quotes[index]?.id,
                      ) ||
                      serializeReplyDraft({ ...current, quotes: current.quotes }) !==
                        serializeReplyDraft(move.after)
                    )
                      return false;
                    quoteMoves.current.moves.pop();
                    updateComposer(childId, (latest) => ({ ...latest, ...move.before }));
                    setActiveTextId(null);
                    return true;
                  }}
                  inputFor={(replyQuote) => ({
                    onChange: (event) => editText(replyQuote.id, event.target.value),
                    onFocus: (event) => focusText(replyQuote.id, event.currentTarget),
                    onKeyDown: handleKeyDown,
                    onPaste,
                  })}
                  onRemove={(id) => {
                    quoteMoves.current.moves = [];
                    if (id === "seed" && quote !== undefined) clearSideChatDraft(childId);
                    else
                      updateComposer(childId, (current) => ({
                        ...current,
                        ...removeReplyQuote({ ...current, quotes: current.quotes ?? [] }, id),
                      }));
                  }}
                />
              ),
          }}
          actions={{
            leading: null,
            trailing: (
              <>
                <ComposerMicButton
                  className="size-8 md:size-7"
                  disabled={!ready}
                  onVoiceStart={dictation.begin}
                  onVoiceDiscard={dictation.discard}
                  onTranscript={(spoken) => dictation.appendFinal(spoken)}
                  onInterim={(spoken) => dictation.replaceInterim(spoken)}
                />

                <ComposerSendButton
                  type="button"
                  label="Send side question"
                  disabled={!canSend || !ready}
                  onClick={submit}
                  data-testid="side-chat-send"
                />
              </>
            ),
          }}
        />
      </div>
    </div>
  );
}
