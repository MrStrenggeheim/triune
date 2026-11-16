// Modified for Triune.
import { useEffect, useState, useRef, type ComponentProps } from "react";
import { FileMentionMenu } from "@/components/FileMentionMenu";
import { Button } from "@/components/ui/button";
import {
  captureReference,
  referenceRequest,
  searchReferenceChats,
  type ContextReference,
  type ReferenceChat,
  type ReferenceItem,
  type ReferenceScope,
} from "@/lib/contextReferences";
import { ContextReferencePreview } from "./ContextReferencePreview";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";

export function ComposerMentionMenu({
  query,
  destinationId,
  onReference,
  ...files
}: ComponentProps<typeof FileMentionMenu> & {
  query: string;
  destinationId: string | null;
  onReference: (reference: ContextReference) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobileViewport();
  const generation = useRef(0);
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const composing = useRef(false);
  const [chats, setChats] = useState<ReferenceChat[]>([]);
  const [chat, setChat] = useState<ReferenceChat | null>(null);
  const [messages, setMessages] = useState<ReferenceItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reference, setReference] = useState<ContextReference | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    setLoading(true);
    setError("");
    setChats([]);
    setChatCursor(null);
    setReference(null);
    setChat(null);
    setChoosing(false);
    searchReferenceChats(query, false, controller.signal, undefined, false)
      .then(
        (page) => {
          if (!controller.signal.aborted) {
            setChats(page.data);
            setChatCursor(page.has_more ? page.next_cursor : null);
          }
        },
        (failure) => {
          if (!controller.signal.aborted) setError(String(failure.message));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      generation.current += 1;
    };
  }, [query]);
  useEffect(() => setActiveIndex(0), [query, files.entries, chats]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const menu = menuRef.current;
      if (!menu || event.isComposing || event.keyCode === 229 || composing.current) return;
      const composer = menu.closest("form") ?? menu.parentElement;
      const inInput =
        event.target instanceof HTMLTextAreaElement && composer?.contains(event.target);
      if (!inInput && !(event.target instanceof Node && menu.contains(event.target))) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (inInput && isMobile && event.key === "Enter") return;
      if (chat) {
        if (inInput && ["Enter", "Tab", "ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
        }
        return;
      }
      if (!["Enter", "Tab", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      // Own the merged list before the composer's file-only controller or Send.
      event.preventDefault();
      event.stopPropagation();
      const rows = Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]'));
      if (!rows.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        setActiveIndex(
          (index) => (index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length,
        );
        return;
      }
      const row = rows[Math.min(activeIndex, rows.length - 1)];
      const selector =
        event.key === "Tab" && row.querySelector("[data-mention-attach]")
          ? "[data-mention-attach]"
          : "[data-mention-primary]";
      row.querySelector<HTMLButtonElement>(selector)?.click();
    };
    const start = () => {
      composing.current = true;
    };
    const end = () => {
      composing.current = false;
    };
    document.addEventListener("keydown", handle, true);
    document.addEventListener("compositionstart", start, true);
    document.addEventListener("compositionend", end, true);
    return () => {
      document.removeEventListener("keydown", handle, true);
      document.removeEventListener("compositionstart", start, true);
      document.removeEventListener("compositionend", end, true);
    };
  }, [activeIndex, chat, isMobile]);
  const loadMessages = async (source: ReferenceChat, after?: string) => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "50", order: "desc" });
      if (after) params.set("after", after);
      const page = await referenceRequest<{
        data: ReferenceItem[];
        has_more: boolean;
        last_id: string;
      }>(`/v1/sessions/${encodeURIComponent(source.id)}/items?${params}`);
      if (generation.current !== requestGeneration) return;
      setMessages((previous) => (after ? [...previous, ...page.data] : page.data));
      setCursor(page.has_more ? page.last_id : null);
      setChoosing(true);
    } catch (failure) {
      if (generation.current === requestGeneration) setError((failure as Error).message);
    } finally {
      if (generation.current === requestGeneration) setLoading(false);
    }
  };
  const capture = async (scope: ReferenceScope) => {
    if (!chat) return;
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await captureReference(chat.id, destinationId, scope, {
        message_ids: selected,
      });
      if (generation.current === requestGeneration) setReference(result);
    } catch (failure) {
      if (generation.current === requestGeneration) setError((failure as Error).message);
    } finally {
      if (generation.current === requestGeneration) setLoading(false);
    }
  };
  return (
    <div
      ref={menuRef}
      data-context-reference-picker
      onMouseDown={(event) => event.preventDefault()}
      className="absolute bottom-full left-0 z-20 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-2 shadow-menu"
    >
      {!chat ? (
        <div className="relative min-h-10 [&>div]:static [&>div>div]:w-full [&>div>div]:border-0 [&>div>div]:shadow-none">
          <FileMentionMenu
            {...files}
            activeIndex={activeIndex}
            query={query}
            chats={chats}
            onChooseChat={(row) => {
              generation.current += 1;
              setChat(row);
              setSelected([]);
              setReference(null);
            }}
          />
          {!files.entries.length && !chats.length && !loading && !files.loading && (
            <p className="p-2 text-sm">No matching references</p>
          )}
        </div>
      ) : (
        <div className="max-h-72 overflow-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              generation.current += 1;
              setChat(null);
              setChoosing(false);
            }}
          >
            ‹ {chat.title}
          </Button>
          {!choosing ? (
            <div className="flex flex-col items-start">
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={() => void capture("whole")}
              >
                Whole chat
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={() => void capture("last_answer")}
              >
                Last completed answer
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={() => void loadMessages(chat)}
              >
                Choose messages
              </Button>
            </div>
          ) : (
            <>
              {messages
                .filter((item) => item.type === "message")
                .map((item) => (
                  <label
                    key={item.id}
                    className="flex gap-2 p-2 text-sm"
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span className="line-clamp-3">
                      {item.created_by ?? item.role}:{" "}
                      {item.content?.map((block) => block.text ?? `[${block.type}]`).join("\n")}
                    </span>
                  </label>
                ))}
              {cursor && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={loading}
                  onClick={() => void loadMessages(chat, cursor)}
                >
                  Earlier messages
                </Button>
              )}
              <Button
                type="button"
                disabled={loading || !selected.length}
                onClick={() => void capture("messages")}
              >
                Preview selection
              </Button>
            </>
          )}
        </div>
      )}
      {!chat && chatCursor && (
        <Button
          type="button"
          variant="ghost"
          disabled={loading}
          onClick={() => {
            const requestGeneration = ++generation.current;
            setLoading(true);
            searchReferenceChats(query, false, undefined, chatCursor, false)
              .then(
                (page) => {
                  if (generation.current !== requestGeneration) return;
                  setChats((previous) => [...previous, ...page.data]);
                  setChatCursor(page.has_more ? page.next_cursor : null);
                },
                (failure) => {
                  if (generation.current === requestGeneration) setError(failure.message);
                },
              )
              .finally(() => {
                if (generation.current === requestGeneration) setLoading(false);
              });
          }}
        >
          More chats
        </Button>
      )}
      {loading && !files.loading && (
        <p role="status" className="p-2 text-sm">
          Loading…
        </p>
      )}
      {error && (
        <p role="alert" className="p-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {reference && (
        <ContextReferencePreview
          reference={reference}
          onClose={() => setReference(null)}
          onAttach={() => onReference(reference)}
        />
      )}
    </div>
  );
}
