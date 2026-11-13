// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon, MessageCircleIcon } from "lucide-react";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { MessageFooter } from "@/components/chat/MessageFooter";
import { Button } from "@/components/ui/button";
import { FilePathAwareMessageResponse } from "@/components/blocks/ChatMarkdown";
import { useConversationChatVisible } from "@/workbench/ScopedChatStore";
import { cn } from "@/lib/utils";
import type { SubagentActivity } from "@/lib/subagentActivity";

/** A child-authored report carried by a lifecycle event, retaining its recorded source. */
export function SubagentReply({
  activity,
  conversationId,
  agentName,
  action,
}: {
  activity: SubagentActivity;
  conversationId: string | null;
  agentName: string;
  action: ReactNode;
}) {
  const text = activity.resultText!;
  const preview = text
    .slice(0, 768)
    .replace(/[\uD800-\uDBFF]$/u, "")
    .split("\n", 4)
    .slice(0, 3)
    .join("\n");
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const visible = useConversationChatVisible();
  const excerptRef = useRef<HTMLDivElement>(null);
  const excerptId = useId();
  const ref = activity.resultRef ?? activity.resultRefs[0];
  const sourceConversationId = ref?.conversationId ?? conversationId;
  const sourceItemId = ref?.itemId ?? activity.itemId;
  const shownText = expanded ? text : preview;
  const parts = activity.resultParts;
  const hasExactParts = parts.length > 0 && parts.map((part) => part.text).join("\n\n") === text;
  let offset = 0;
  const segments = hasExactParts
    ? parts.flatMap((part) => {
        const shown = shownText.slice(offset, offset + part.text.length);
        offset += part.text.length + 2;
        return shown ? [{ ...part, text: shown }] : [];
      })
    : [{ text: shownText, ref: { conversationId: sourceConversationId, itemId: sourceItemId } }];

  useEffect(() => {
    const element = excerptRef.current;
    if (!element || expanded || !visible) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded, visible]);

  return (
    <article
      className="group min-w-0 border-l-2 border-primary/60 pl-2.5 text-sm sm:pl-3"
      data-testid="subagent-reply"
      data-phase="returned"
      data-child-session-id={activity.sessionId}
      data-message-id={activity.itemId ?? undefined}
    >
      <header className="flex min-h-7 min-w-0 items-center gap-1.5">
        <MessageCircleIcon aria-hidden className="size-4 shrink-0 text-primary" />
        <strong className="min-w-0 truncate font-semibold">{agentName}</strong>{" "}
        <span className="shrink-0 text-muted-foreground">replied</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">{action}</span>
      </header>
      <div className="pt-0.5 sm:pl-[22px]">
        <div
          ref={excerptRef}
          id={excerptId}
          className={cn(
            "whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]",
            !expanded && "line-clamp-3 max-h-[60px]",
          )}
        >
          {segments.map((segment) => (
            <ConversationScopeContext.Provider
              key={`${segment.ref.conversationId}:${segment.ref.itemId}`}
              value={segment.ref.conversationId}
            >
              <FilePathAwareMessageResponse
                sourceItemId={segment.ref.itemId}
                breaks
                mode="static"
                className="text-sm leading-5 [&>*]:my-0 [&_p]:my-0 [&_p]:leading-5"
              >
                {segment.text}
              </FilePathAwareMessageResponse>
            </ConversationScopeContext.Provider>
          ))}
        </div>
        {(preview !== text || clipped || expanded) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1 px-0 py-0.5 text-xs text-muted-foreground"
            aria-expanded={expanded}
            aria-controls={excerptId}
            onClick={() => setExpanded((value) => !value)}
          >
            Show {expanded ? "less" : "full"}
            {expanded ? (
              <ChevronUpIcon className="size-3.5" aria-hidden />
            ) : (
              <ChevronDownIcon className="size-3.5" aria-hidden />
            )}
          </Button>
        )}
        <MessageFooter
          text={text}
          messageId={sourceItemId}
          conversationId={sourceConversationId}
          createdAtS={activity.createdAtS}
        />
      </div>
    </article>
  );
}
