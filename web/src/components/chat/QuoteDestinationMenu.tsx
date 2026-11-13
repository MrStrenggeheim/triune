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
import { toast } from "@/lib/notifications";

export function QuoteDestinationMenu({
  source: selectedSource,
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
  // One menu owns one captured selection, independent of caller rerenders.
  const source = useRef(selectedSource).current;
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
  const startedDestination = useRef<ReferenceChat | "new" | null>(null);
  const inserting = useRef(false);
  const inserted = useRef(false);
  const [query, setQuery] = useState("");
  const [finding, setFinding] = useState(false);
  const [chats, setChats] = useState<ReferenceChat[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState<ContextReference | null>(null);
  const [captureAttempt, setCaptureAttempt] = useState(0);
  const loading = useRef<string | number | undefined>(undefined);
  useEffect(() => {
    if (intent !== "subchat") return;
    loading.current = toast.loading("Opening subchat…");
    return () => {
      if (loading.current !== undefined) toast.dismiss(loading.current);
    };
  }, [intent]);
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
        if (alive && active.current) {
          setError(failure.message);
          if (intent === "subchat") {
            toast.error(failure.message, {
              id: loading.current,
              action: {
                label: "Retry",
                onClick: () => setCaptureAttempt((attempt) => attempt + 1),
              },
            });
          }
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [source, captureAttempt, intent]);
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
  const insert = useCallback(async (): Promise<void> => {
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
        const openCreated = (id: string) => {
          if (!active.current || inserted.current) return;
          insertQuoteReference(id, reference, true);
          inserted.current = true;
          navigation.openConversation(id, { beside: true, title: "Subchat" });
          window.getSelection()?.removeAllRanges();
          close();
        };
        targetId = await navigation.createSubchat(
          {
            ...source,
            boundaryId: reference.boundary_id,
          },
          openCreated,
        );
        // Compatibility with providers that only return an initialized child.
        openCreated(targetId);
        return;
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
      navigation.openConversation(targetId, {
        beside: true,
        title: destination.title,
      });
      window.getSelection()?.removeAllRanges();
      close();
    } catch (failure) {
      const message = (failure as Error).message;
      if (active.current) setError(message);
      if (intent === "subchat" || inserted.current) {
        toast.error(message, {
          id: loading.current,
          action: {
            label: "Retry",
            onClick: () => {
              if (inserted.current && navigation?.createSubchat && reference) {
                void navigation
                  .createSubchat({ ...source, boundaryId: reference.boundary_id })
                  .catch((retryFailure) => toast.error((retryFailure as Error).message));
              } else void insert();
            },
          },
        });
      }
    } finally {
      inserting.current = false;
      if (active.current) setBusy(false);
    }
  }, [destination, navigation, source, reference, close, intent]);
  useEffect(() => {
    if (!destination || (!source.file && !reference) || startedDestination.current === destination)
      return;
    startedDestination.current = destination;
    void insert();
  }, [destination, source, reference, insert]);
  if (intent === "subchat") return null;
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
        aria-label="Send to"
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
          !error && (
            <p role="status" className="p-2 text-sm">
              {destination === "new" ? "Opening subchat…" : "Inserting quote…"}
            </p>
          )
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
        {error && destination && (source.file || reference) && (
          <Button variant="ghost" disabled={busy} onClick={() => void insert()}>
            Retry
          </Button>
        )}
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
      </PopoverContent>
    </Popover>
  );
}
