import { ContentSkeleton } from "@/components/ui/loading";
// Modified for Triune.
import { useEffect, useState, useRef, type ComponentProps } from "react";
import { FileMentionMenu } from "@/components/FileMentionMenu";
import { Button } from "@/components/ui/button";
import { searchReferenceChats, type ChatLink, type ReferenceChat } from "@/lib/contextReferences";
import { useRebasePath } from "@/lib/routing";
import { getShareableLink } from "@/lib/sessionShareLink";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";

export function ComposerMentionMenu({
  query,
  onReference,
  ...files
}: ComponentProps<typeof FileMentionMenu> & {
  query: string;
  onReference: (reference: ChatLink) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const rebasePath = useRebasePath();
  const isMobile = useIsMobileViewport();
  const generation = useRef(0);
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const composing = useRef(false);
  const [chats, setChats] = useState<ReferenceChat[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    setLoading(true);
    setError("");
    setChats([]);
    setChatCursor(null);
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
  }, [activeIndex, isMobile]);
  return (
    <div
      ref={menuRef}
      data-context-reference-picker
      onMouseDown={(event) => event.preventDefault()}
      className="absolute bottom-full left-0 z-20 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-2 shadow-menu"
    >
      <div className="relative min-h-10 [&>div]:static [&>div>div]:w-full [&>div>div]:border-0 [&>div>div]:shadow-none">
        <FileMentionMenu
          {...files}
          activeIndex={activeIndex}
          query={query}
          chats={chats}
          onChooseChat={(row) =>
            onReference({
              version: 2,
              source_id: row.id,
              source_title: row.title,
              url: getShareableLink(row.id, rebasePath),
            })
          }
        />
        {!files.entries.length && !chats.length && !loading && !files.loading && (
          <p className="p-2 text-sm">No matching references</p>
        )}
      </div>
      {chatCursor && (
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
      {loading && !files.loading && <ContentSkeleton label="Loading mentions…" rows={3} />}
      {error && (
        <p role="alert" className="p-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
