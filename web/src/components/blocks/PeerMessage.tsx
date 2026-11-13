// Modified for Triune.
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, EllipsisIcon, MessageCircleIcon } from "lucide-react";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessageFooter } from "@/components/chat/MessageFooter";
import { FilePathAwareMessageResponse } from "@/components/blocks/ChatMarkdown";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { useConversationChatStore, useConversationChatVisible } from "@/workbench/ScopedChatStore";
import type { MessageCommunication } from "@/lib/messageCommunication";
import type { MessageContentBlock } from "@/lib/blocks";
import type { Session } from "@/lib/types";
import { Link } from "@/lib/routing";
import { cn } from "@/lib/utils";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";
import { getSessionSlim } from "@/lib/sessionsApi";
import { getOmnigentServerIdentity } from "@/lib/host";
import { useViewerId } from "@/hooks/useViewerId";

interface PeerMessageProps {
  communication: MessageCommunication;
  content: MessageContentBlock[];
  itemId: string;
  createdAtS?: number;
  pending?: boolean;
}

type PeerSource = Pick<Session, "title" | "subAgentName" | "agentName">;
const selectPeerSource = ({ title, subAgentName, agentName }: Session): PeerSource => ({
  title,
  subAgentName,
  agentName,
});

function AuthorizedPeerMessage(props: PeerMessageProps) {
  const viewer = useViewerId();
  const visible = useConversationChatVisible();
  const id = props.communication.source_conversation_id;
  const query = useQuery({
    queryKey: ["peer-source-label", getOmnigentServerIdentity(), viewer, id],
    queryFn: () => getSessionSlim(id!, { refreshState: false }),
    enabled: visible && !!id,
    staleTime: 30_000,
    refetchInterval: false,
    retry: false,
    throwOnError: false,
    select: selectPeerSource,
  });
  return (
    <PeerMessageContent
      {...props}
      source={!query.isError ? query.data : undefined}
      sourceAgentName={!query.isError ? props.communication.source_agent_name : undefined}
    />
  );
}

export function PeerMessage(props: PeerMessageProps) {
  const queryClient = useContext(QueryClientContext);
  return queryClient && props.communication.source_conversation_id ? (
    <AuthorizedPeerMessage {...props} />
  ) : (
    <PeerMessageContent
      {...props}
      sourceTitle={props.communication.source_title}
      sourceAgentName={props.communication.source_agent_name}
    />
  );
}

function PeerMessageContent({
  communication,
  content,
  itemId,
  createdAtS,
  pending,
  source,
  sourceTitle,
  sourceAgentName,
}: PeerMessageProps & {
  source?: PeerSource;
  sourceTitle?: string | null;
  sourceAgentName?: string | null;
}) {
  const workbench = useWorkbenchActions();
  const useChatStore = useConversationChatStore();
  const scopedConversationId = useContext(ConversationScopeContext);
  const conversationId = useChatStore((state) => scopedConversationId ?? state.conversationId);
  const flashing = useChatStore((state) => state.flashItemId === itemId);
  const visible = useConversationChatVisible();
  const text = useMemo(
    () =>
      content
        .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
        .filter(Boolean)
        .join("\n"),
    [content],
  );
  // Parse only a bounded excerpt while collapsed; Copy always uses the full source.
  const preview = useMemo(
    () =>
      text
        .slice(0, 768)
        .replace(/[\uD800-\uDBFF]$/u, "")
        .split("\n", 4)
        .slice(0, 3)
        .join("\n"),
    [text],
  );
  const name =
    sourceAgentName?.trim() || source?.subAgentName?.trim() || source?.agentName?.trim() || "Agent";
  const sourceId = communication.source_conversation_id;
  const title = source?.title?.trim() || sourceTitle?.trim() || "conversation";
  const messageConversationId =
    conversationId === sourceId ? sourceId : communication.destination_conversation_id;
  const menuConversationId =
    conversationId === sourceId
      ? communication.destination_conversation_id
      : sourceId || communication.destination_conversation_id;
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const excerptRef = useRef<HTMLDivElement>(null);
  const excerptId = useId();

  useEffect(() => {
    const element = excerptRef.current;
    if (!element || expanded || !visible) return;
    const measure = () =>
      setClipped(preview !== text || element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, preview, expanded, visible]);

  return (
    <article
      className="group min-w-0 border-l-2 border-primary/60 pl-2.5 text-sm sm:pl-3"
      data-testid="peer-message"
      data-message-id={itemId}
    >
      <header className="flex min-h-7 min-w-0 items-center gap-1.5">
        <MessageCircleIcon className="size-4 shrink-0 text-primary" aria-hidden />
        <strong className="max-w-[40%] truncate font-semibold">{name}</strong>{" "}
        {sourceId && (
          <>
            <span className="shrink-0 text-muted-foreground">from</span>{" "}
            <Link
              to={`/c/${encodeURIComponent(sourceId)}`}
              className="min-w-0 truncate rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                if (
                  workbench &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  workbench.openConversation(sourceId, { beside: true });
                }
              }}
            >
              {title}
            </Link>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Message actions"
              className="ml-auto shrink-0 text-muted-foreground"
            >
              <EllipsisIcon className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link
                to={`/c/${encodeURIComponent(menuConversationId)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open {menuConversationId === sourceId ? "source" : "receiving"} chat in new tab
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="pt-0.5 sm:pl-[22px]">
        <div
          ref={excerptRef}
          id={excerptId}
          className={cn(
            "whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]",
            !expanded && "line-clamp-3 max-h-[60px]",
            flashing && "animate-message-highlight",
          )}
        >
          <ConversationScopeContext.Provider value={messageConversationId ?? null}>
            <FilePathAwareMessageResponse
              sourceItemId={itemId}
              breaks
              mode="static"
              className="text-sm leading-5 [&>*]:my-0 [&_p]:my-0 [&_p]:leading-5"
            >
              {expanded ? text : preview}
            </FilePathAwareMessageResponse>
          </ConversationScopeContext.Provider>
        </div>
        {(clipped || expanded) && (
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
          messageId={pending ? null : itemId}
          conversationId={messageConversationId}
          createdAtS={createdAtS ?? communication.sent_at ?? undefined}
        />
      </div>
    </article>
  );
}
