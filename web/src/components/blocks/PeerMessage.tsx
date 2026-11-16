// Modified for Triune.
import { useAgentPresentation } from "@/hooks/useAgentPresentation";
import { useContext, useMemo } from "react";
import { CheckIcon, ClockIcon, CircleAlertIcon, MessageCircleIcon, SendIcon } from "lucide-react";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
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
  /** Conversation-local aliases verified by the receipt projection. */
  aliases?: readonly string[];
  /** Exact item in the linked conversation, provided by authorized server records. */
  relatedItemId?: string;
  createdAtS?: number;
  pending?: boolean;
}

type PeerSource = Pick<
  Session,
  "title" | "subAgentName" | "agentName" | "labels" | "parentSessionId"
>;
const selectPeerSource = ({
  title,
  subAgentName,
  agentName,
  labels,
  parentSessionId,
}: Session): PeerSource => ({
  title,
  subAgentName,
  agentName,
  labels,
  parentSessionId,
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
      sourceDenied={query.isError}
      destinationDenied={destination.isError}
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
  aliases,
  relatedItemId,
  source,
  destination,
  sourceTitle,
  sourceAgentName,
  sourceDenied,
  destinationDenied,
}: PeerMessageProps & {
  source?: PeerSource;
  destination?: PeerSource;
  sourceTitle?: string | null;
  sourceAgentName?: string | null;
  sourceDenied?: boolean;
  destinationDenied?: boolean;
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
  const fallbackPreview = useMemo(
    () =>
      text
        .slice(0, 768)
        .replace(/[\uD800-\uDBFF]$/u, "")
        .split("\n", 4)
        .slice(0, 3)
        .join("\n"),
    [text],
  );
  const sourceId = communication.source_conversation_id;
  const outgoing = !!sourceId && conversationId === sourceId;
  const relatedId = outgoing ? communication.destination_conversation_id : sourceId;
  const sender = useAgentPresentation(sourceId ?? "", conversationId, {
    session: source,
    recordedName: sourceAgentName,
    recordedTitle: sourceTitle,
    denied: sourceDenied,
  });
  const recipient = useAgentPresentation(
    communication.destination_conversation_id,
    conversationId,
    { session: destination, denied: destinationDenied },
  );
  const name = sender.name;
  const relatedDisplay = outgoing ? recipient : sender;
  const relatedTitle = relatedDisplay.name;
  const preview = relatedDisplay.preview ?? fallbackPreview;
  const messageConversationId =
    conversationId === sourceId ? sourceId : communication.destination_conversation_id;
  const relatedHref = relatedId
    ? `/c/${encodeURIComponent(relatedId)}${relatedItemId ? `?message=${encodeURIComponent(relatedItemId)}` : ""}`
    : undefined;
  const deliveryLabel =
    communication.delivery_state === "confirmed"
      ? "Received"
      : communication.delivery_state === "failed"
        ? "Failed"
        : communication.delivery_state === "unknown"
          ? "Unknown delivery"
          : "Queued";
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
      data-message-aliases={aliases ? JSON.stringify(aliases) : undefined}
      data-delivery-state={communication.delivery_state}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <ActivityRow
              presentation="message"
              searchItemIds={[itemId, ...(aliases ?? [])]}
              status={
                <Badge
                  variant={communication.delivery_state === "failed" ? "destructive" : "secondary"}
                  role="status"
                  className="w-fit text-xs font-normal"
                >
                  {communication.delivery_state === "confirmed" ? (
                    <CheckIcon aria-hidden="true" />
                  ) : communication.delivery_state === "failed" ? (
                    <CircleAlertIcon aria-hidden="true" />
                  ) : (
                    <ClockIcon aria-hidden="true" />
                  )}
                  {deliveryLabel}
                </Badge>
              }
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
                        to={relatedHref!}
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
                            workbench.openConversation(relatedId, {
                              beside: true,
                              messageId: relatedItemId,
                            });
                          }
                        }}
                      >
                        {relatedTitle}
                      </Link>
                    </>
                  )}
                  {relatedDisplay.task && (
                    <span className="min-w-0 truncate">· {relatedDisplay.task}</span>
                  )}
                </>
              }
              actions={
                <ActivityNavigation
                  name={relatedTitle}
                  openHref={relatedHref}
                  onOpen={
                    relatedId && workbench
                      ? () =>
                          workbench.openConversation(relatedId, {
                            beside: true,
                            messageId: relatedItemId,
                          })
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
                relatedDisplay.preview ? (
                  <span>{preview}</span>
                ) : (
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
                )
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
