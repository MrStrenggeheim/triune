// Modified for Triune.
import { useContext, useMemo } from "react";
import { MessageCircleIcon, SendIcon } from "lucide-react";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { ActivityRow } from "@/components/ActivityRow";
import { ActivityNavigation } from "@/shell/ChatActivityPanel";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
  const useChatStore = useConversationChatStore();
  const scoped = useContext(ConversationScopeContext);
  const viewing = useChatStore((state) => scoped ?? state.conversationId);
  const outgoing = !!id && viewing === id;
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
  const destination = useQuery({
    queryKey: [
      "peer-source-label",
      getOmnigentServerIdentity(),
      viewer,
      props.communication.destination_conversation_id,
    ],
    queryFn: () =>
      getSessionSlim(props.communication.destination_conversation_id, { refreshState: false }),
    enabled: visible && outgoing,
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
      destination={!destination.isError ? destination.data : undefined}
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
  source,
  destination,
  sourceTitle,
  sourceAgentName,
}: PeerMessageProps & {
  source?: PeerSource;
  destination?: PeerSource;
  sourceTitle?: string | null;
  sourceAgentName?: string | null;
}) {
  const workbench = useWorkbenchActions();
  const useChatStore = useConversationChatStore();
  const scopedConversationId = useContext(ConversationScopeContext);
  const conversationId = useChatStore((state) => scopedConversationId ?? state.conversationId);
  const flashing = useChatStore((state) => state.flashItemId === itemId);
  const text = useMemo(
    () =>
      content
        .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
        .filter(Boolean)
        .join("\n"),
    [content],
  );
  // Parse only a bounded excerpt while collapsed.
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
  const outgoing = !!sourceId && conversationId === sourceId;
  const relatedId = outgoing ? communication.destination_conversation_id : sourceId;
  const title = source?.title?.trim() || sourceTitle?.trim() || "conversation";
  const relatedTitle = outgoing ? destination?.title?.trim() || "conversation" : title;
  const messageConversationId =
    conversationId === sourceId ? sourceId : communication.destination_conversation_id;
  const menuConversationId =
    conversationId === sourceId
      ? communication.destination_conversation_id
      : sourceId || communication.destination_conversation_id;

  return (
    <article
      className="group min-w-0 text-sm"
      data-testid="peer-message"
      data-direction={outgoing ? "sent" : "received"}
      data-message-id={itemId}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <ActivityRow
              presentation="message"
              icon={
                outgoing ? (
                  <SendIcon aria-hidden="true" />
                ) : (
                  <MessageCircleIcon aria-hidden="true" />
                )
              }
              title={
                <>
                  <strong className="max-w-[40%] truncate font-semibold">{name}</strong>{" "}
                  {relatedId && (
                    <>
                      <span className="shrink-0 text-muted-foreground">
                        {outgoing ? "sent to" : "from"}
                      </span>{" "}
                      <Link
                        to={`/c/${encodeURIComponent(relatedId)}`}
                        className="min-w-0 truncate rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(event) => {
                          if (
                            event.button === 0 &&
                            workbench &&
                            !event.metaKey &&
                            !event.ctrlKey &&
                            !event.shiftKey &&
                            !event.altKey
                          ) {
                            event.preventDefault();
                            workbench.openConversation(relatedId, { beside: true });
                          }
                        }}
                      >
                        {relatedTitle}
                      </Link>
                    </>
                  )}
                </>
              }
              actions={
                <ActivityNavigation
                  name={relatedTitle}
                  openHref={relatedId ? `/c/${encodeURIComponent(relatedId)}` : undefined}
                  onOpen={
                    relatedId && workbench
                      ? () => workbench.openConversation(relatedId, { beside: true })
                      : undefined
                  }
                  orchestrationHref={
                    relatedId ? `/c/${encodeURIComponent(relatedId)}?panel=activity` : undefined
                  }
                  onOrchestration={
                    relatedId && workbench
                      ? () =>
                          workbench.openView(
                            {
                              kind: "activity",
                              source: { kind: "chat", conversationId: relatedId },
                              title: "Orchestration",
                            },
                            { beside: true },
                          )
                      : undefined
                  }
                />
              }
              summary={
                <ConversationScopeContext.Provider value={messageConversationId ?? null}>
                  <FilePathAwareMessageResponse
                    sourceItemId={itemId}
                    breaks
                    mode="static"
                    className={cn(
                      "text-sm leading-5 [&>*]:my-0 [&_p]:my-0 [&_p]:leading-5",
                      flashing && "animate-message-highlight",
                    )}
                  >
                    {preview}
                  </FilePathAwareMessageResponse>
                </ConversationScopeContext.Provider>
              }
            >
              <ConversationScopeContext.Provider value={messageConversationId ?? null}>
                <FilePathAwareMessageResponse
                  sourceItemId={itemId}
                  breaks
                  mode="static"
                  className="text-sm leading-5 [&>*]:my-0 [&_p]:my-0 [&_p]:leading-5"
                >
                  {text}
                </FilePathAwareMessageResponse>
              </ConversationScopeContext.Provider>
            </ActivityRow>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent alignOffset={0}>
          <ContextMenuItem asChild>
            <Link
              to={`/c/${encodeURIComponent(menuConversationId)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open {menuConversationId === sourceId ? "source" : "receiving"} chat in new tab
            </Link>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </article>
  );
}
