// Modified for Triune.
import { useCallback, useContext, useEffect, useState, useRef } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContextReferenceNavigationContext } from "@/lib/contextReferenceNavigation";
import {
  captureReference,
  referenceRequest,
  searchReferenceChats,
  type ContextReference,
  type QuoteSource,
  type ReferenceChat,
} from "@/lib/contextReferences";
import { insertQuoteDraft, insertQuoteReference } from "@/lib/quoteDraftDestinations";
import { textSelectionMenuClassName } from "./TextSelectionMenu";

export function QuoteDestinationMenu({
  source,
  x,
  y,
  onClose,
  intent = "pick",
}: {
  source: QuoteSource;
  x: number;
  y: number;
  onClose: () => void;
  intent?: "pick" | "subchat";
}) {
  const navigation = useContext(ContextReferenceNavigationContext);
  const active = useRef(true);
  const focusBeforeOpen = useRef(document.activeElement as HTMLElement | null);
  const restoreFocus = useRef(true);
  const [open, setOpen] = useState(true);
  const close = useCallback(() => {
    active.current = false;
    setOpen(false);
    onClose();
  }, [onClose]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const createdSubchat = useRef<string | null>(null);
  const autoStarted = useRef(false);
  const inserting = useRef(false);
  const [query, setQuery] = useState("");
  const [finding, setFinding] = useState(false);
  const [chats, setChats] = useState<ReferenceChat[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState<ContextReference | null>(null);
  const [captureAttempt, setCaptureAttempt] = useState(0);
  useEffect(() => {
    if (source.file) return;
    let alive = true;
    setError("");
    captureReference(source.conversationId, null, "quote", {
      boundary_id: source.boundaryId,
      message_ids: source.messageIds,
      quote: source.text,
    }).then(
      (value) => {
        if (alive && active.current) setReference(value);
      },
      (failure) => {
        if (alive && active.current) setError(failure.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [source, captureAttempt]);
  const [destination, setDestination] = useState<ReferenceChat | "new" | null>(
    intent === "subchat" ? "new" : null,
  );
  useEffect(() => {
    if (intent === "subchat") return;
    const controller = new AbortController();
    searchReferenceChats(query, true, controller.signal).then(
      (page) => {
        if (!controller.signal.aborted && active.current) setChats(page.data);
      },
      (failure) => {
        if (!controller.signal.aborted && active.current) setError(failure.message);
      },
    );
    return () => controller.abort();
  }, [query, intent]);
  const insert = useCallback(async () => {
    if (!destination || inserting.current || !active.current) return;
    inserting.current = true;
    setBusy(true);
    setError("");
    try {
      let targetId: string;
      if (!navigation) throw new Error("Conversation navigation is unavailable in this view");
      if (!source.file && !reference) throw new Error("The source snapshot is not ready");
      if (destination === "new") {
        if (!navigation?.createSubchat || !reference)
          throw new Error("Subchat creation is unavailable for this source");
        createdSubchat.current ??= await navigation.createSubchat({
          ...source,
          boundaryId: reference.boundary_id,
        });
        targetId = createdSubchat.current;
      } else targetId = destination.id;
      if (!active.current) return;
      await referenceRequest(
        `/v1/sessions/${encodeURIComponent(source.conversationId)}/context-reference/check`,
        { destination_id: targetId, scope: "quote" },
      );
      if (!active.current) return;
      if (reference) insertQuoteReference(targetId, reference);
      else
        insertQuoteDraft(
          targetId,
          `[File selection: ${JSON.stringify({ ...source.file, source_id: source.conversationId })}]\n${source.text}`,
        );
      navigation.openConversation(targetId, { beside: true });
      window.getSelection()?.removeAllRanges();
      close();
    } catch (failure) {
      if (active.current) setError((failure as Error).message);
    } finally {
      inserting.current = false;
      if (active.current) setBusy(false);
    }
  }, [destination, navigation, source, reference, close]);
  useEffect(() => {
    if (intent !== "subchat" || !reference || autoStarted.current) return;
    autoStarted.current = true;
    void insert();
  }, [intent, reference, insert]);
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <PopoverAnchor asChild>
        <span aria-hidden style={{ position: "fixed", left: x, top: y, width: 0, height: 0 }} />
      </PopoverAnchor>
      <PopoverContent
        data-text-selection-menu
        data-context-reference-picker
        aria-label={intent === "subchat" ? "Ask subchat" : "Send to"}
        align="start"
        sideOffset={0}
        collisionPadding={8}
        className={`${textSelectionMenuClassName} static w-80 max-w-[calc(100vw-1rem)] gap-0 p-2`}
        style={{ maxHeight: "calc(100vh - 16px)" }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={() => {
          restoreFocus.current = false;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (restoreFocus.current && focusBeforeOpen.current?.isConnected)
            focusBeforeOpen.current.focus();
        }}
      >
        {destination ? (
          <>
            <p className="p-2 text-sm">
              The quote will be copied to{" "}
              {destination === "new" ? "a new subchat" : destination.title}, visible to everyone
              with access, including future participants.
            </p>
            <Button disabled={busy || (!source.file && !reference)} onClick={() => void insert()}>
              {intent === "subchat" ? "Ask subchat…" : "Insert quote"}
            </Button>
            {intent !== "subchat" && (
              <Button variant="ghost" disabled={busy} onClick={() => setDestination(null)}>
                Back
              </Button>
            )}
          </>
        ) : (
          <>
            {navigation?.createSubchat && !source.file && (
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => setDestination("new")}
              >
                New subchat
              </Button>
            )}
            {finding ? (
              <Input
                autoFocus
                aria-label="Find chat"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            ) : (
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => setFinding(true)}
              >
                Find chat…
              </Button>
            )}
            <div className="slim-scrollbar max-h-52 overflow-auto">
              {chats.map((chat) => (
                <Button
                  key={chat.id}
                  variant="ghost"
                  className="h-auto w-full justify-start whitespace-normal text-left"
                  onClick={() => setDestination(chat)}
                >
                  {chat.title}
                  {chat.parent_id ? ` · ${chat.id.slice(0, 8)}` : ""}
                </Button>
              ))}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="p-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {error && !source.file && !reference && (
          <Button variant="ghost" onClick={() => setCaptureAttempt((attempt) => attempt + 1)}>
            Retry capture
          </Button>
        )}
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
      </PopoverContent>
    </Popover>
  );
}
