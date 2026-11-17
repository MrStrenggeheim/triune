// Modified for Triune.
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { GripVerticalIcon } from "lucide-react";
import { CloseButton } from "@/components/CloseButton";
import { Button } from "@/components/ui/button";
import { getEmbedRoot } from "@/lib/host";
import { textareaDropCaret, type TextareaDropCaret } from "@/lib/textareaDropCaret";
import { useAutoGrowTextarea } from "@/hooks/useAutoGrowTextarea";
import type { ReplyQuote } from "@/lib/replyDraft";
import { ComposerTextInput } from "./ChatComposer";

type TextInputProps = ComponentProps<typeof ComposerTextInput>;
type DropTarget = TextareaDropCaret & { textId: string | null };

function ReplyTextInput({ input, keyboard, onGrowth }: TextInputProps & { onGrowth?: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrowTextarea(ref, String(input.value ?? ""), Infinity, onGrowth);
  return (
    <ComposerTextInput
      keyboard={keyboard}
      input={{ ...input, ref, className: "min-h-[20.8px] max-h-none overflow-y-hidden" }}
    />
  );
}

export function ReplyDraftBlocks({
  quotes,
  keyboard,
  inputFor,
  onRemove,
  onGrowth,
  disabled,
  activeTextId,
  onMove,
  onUndoMove,
}: {
  quotes: ReplyQuote[];
  keyboard: TextInputProps["keyboard"];
  inputFor: (quote: ReplyQuote) => TextInputProps["input"];
  onRemove: (id: string) => void;
  onGrowth?: () => void;
  disabled: boolean;
  activeTextId: string | null;
  onMove?: (id: string, targetTextId: string | null, offset: number) => void;
  /** Returns false when later text edits must use the textarea's own undo. */
  onUndoMove?: () => boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; x: number; y: number; dragged: boolean } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [caret, setCaret] = useState<DropTarget | null>(null);
  const caretRef = useRef<DropTarget | null>(null);
  const cancel = () => {
    pointer.current = null;
    caretRef.current = null;
    setCaret(null);
    setMovingId(null);
  };
  const targetFor = (textarea: HTMLTextAreaElement, point?: { x: number; y: number }) => {
    if (textarea.disabled || textarea.readOnly) return null;
    const position = textareaDropCaret(textarea, point);
    return position ? { ...position, textId: textarea.dataset.replyTextId ?? null } : null;
  };
  const place = (target: DropTarget | null) => {
    if (!movingId || !onMove || !target) return;
    onMove(movingId, target.textId, target.offset);
    cancel();
  };
  useEffect(() => {
    if (movingId && (disabled || !onMove || !quotes.some((quote) => quote.id === movingId))) {
      cancel();
      return;
    }
    const area = root.current?.closest<HTMLElement>("[data-composer-input-area]");
    if (!area || disabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z" &&
        onUndoMove?.()
      ) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (movingId && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (movingId && event.key === "Enter" && event.target instanceof HTMLTextAreaElement) {
        event.preventDefault();
        event.stopPropagation();
        place(targetFor(event.target));
      }
    };
    const click = (event: MouseEvent) => {
      if (movingId && !pointer.current && event.target instanceof HTMLTextAreaElement)
        place(targetFor(event.target));
    };
    const showCaret = (event: Event) => {
      if (!movingId || !(event.target instanceof HTMLTextAreaElement)) return;
      const next = targetFor(event.target);
      caretRef.current = next;
      setCaret(next);
    };
    area.addEventListener("keydown", keydown, true);
    area.addEventListener("keyup", showCaret);
    area.addEventListener("focusin", showCaret);
    area.addEventListener("click", click);
    return () => {
      area.removeEventListener("keydown", keydown, true);
      area.removeEventListener("keyup", showCaret);
      area.removeEventListener("focusin", showCaret);
      area.removeEventListener("click", click);
    };
  });
  return (
    <div ref={root} className="flex flex-col gap-1.5 pb-2" data-testid="composer-reply-blocks">
      {movingId && (
        <span role="status" className="sr-only">
          Choose a text position, then press Enter to place the quote. Escape cancels.
        </span>
      )}
      {quotes.map((quote, index) => (
        <div key={quote.id} className="flex flex-col gap-1.5">
          {(quote.before !== "" || index > 0 || activeTextId === quote.id || movingId !== null) && (
            <ReplyTextInput
              keyboard={keyboard}
              onGrowth={onGrowth}
              input={{
                ...inputFor(quote),
                value: quote.before,
                "aria-label": `Reply text before quote ${index + 1}`,
                disabled,
                rows: 1,
                ...{ "data-reply-text-id": quote.id },
              }}
            />
          )}
          <blockquote
            className="flex w-full min-w-0 items-center gap-1 rounded-none border-l-2 border-l-primary/60 bg-muted/40 px-2 py-1.5 text-sm text-muted-foreground"
            data-testid="composer-reply-quote"
            title={quote.text}
          >
            {onMove && (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Move quote ${index + 1}`}
                aria-pressed={movingId === quote.id}
                className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
                disabled={disabled}
                onClick={(event) => {
                  if (event.detail === 0) setMovingId((id) => (id === quote.id ? null : quote.id));
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || disabled) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.focus({ preventScroll: true });
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  pointer.current = {
                    id: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    dragged: false,
                  };
                  setMovingId(quote.id);
                }}
                onPointerMove={(event) => {
                  const drag = pointer.current;
                  if (!drag || drag.id !== event.pointerId) return;
                  if (
                    Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4 &&
                    !drag.dragged
                  )
                    return;
                  drag.dragged = true;
                  const area = root.current?.closest<HTMLElement>("[data-composer-input-area]");
                  const bounds = area?.getBoundingClientRect();
                  if (area && bounds) {
                    if (event.clientY < bounds.top + 20) area.scrollTop -= 16;
                    else if (event.clientY > bounds.bottom - 20) area.scrollTop += 16;
                  }
                  const target = event.currentTarget.ownerDocument.elementFromPoint(
                    event.clientX,
                    event.clientY,
                  );
                  const next =
                    target instanceof HTMLTextAreaElement && area?.contains(target)
                      ? targetFor(target, { x: event.clientX, y: event.clientY })
                      : null;
                  caretRef.current = next;
                  setCaret(next);
                }}
                onPointerUp={(event) => {
                  const drag = pointer.current;
                  pointer.current = null;
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  if (drag?.dragged) {
                    if (caretRef.current) place(caretRef.current);
                    else cancel();
                  }
                }}
                onPointerCancel={cancel}
                onLostPointerCapture={() => {
                  if (pointer.current) cancel();
                }}
              >
                <GripVerticalIcon className="size-3.5" />
              </Button>
            )}
            <span className="min-w-0 flex-1 truncate">
              {quote.text.length > 120 ? `${quote.text.slice(0, 120)}…` : quote.text}
            </span>
            <CloseButton
              onClick={() => onRemove(quote.id)}
              disabled={disabled}
              aria-label="Remove quote"
            />
          </blockquote>
        </div>
      ))}
      {caret &&
        createPortal(
          <span
            aria-hidden="true"
            data-quote-insertion-caret
            className="pointer-events-none fixed z-50 w-0.5 bg-primary"
            style={{ left: caret.left, top: caret.top, height: caret.height }}
          />,
          getEmbedRoot() ?? document.body,
        )}
    </div>
  );
}
