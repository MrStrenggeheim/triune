// Footer logic inherited under Apache-2.0; Triune changes follow LICENSING.md.
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, Link2Icon } from "lucide-react";
import { MessageAction, MessageActions } from "@/components/ai-elements/message";
import { showToast } from "@/components/ui/toast";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { copyText } from "@/lib/clipboard";
import { buildMessageDeepLink } from "@/lib/messageDeepLink";
import { toast } from "@/lib/notifications";
import { useRebasePath } from "@/lib/routing";

export function formatBubbleTimestamp(epochSeconds: number | undefined): string | null {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return null;
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return `${date.toLocaleDateString(undefined, options)}, ${time}`;
}

/** Copy the complete message, independently of its visible excerpt. */
export function useCopyMessage(
  getText: () => string,
  copy: (value: string) => Promise<void> = copyText,
): { isCopied: boolean; handleCopy: () => void } {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const isMobile = useIsMobileViewport();

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  const handleCopy = useCallback(() => {
    if (isCopied) return;
    const text = getText();
    if (!text) return;
    copy(text).then(
      () => {
        setIsCopied(true);
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000);
        if (isMobile) {
          showToast(<span className="text-ui">Copied to clipboard</span>, { duration: 1500 });
        }
      },
      () => toast.error("Could not copy message"),
    );
  }, [copy, getText, isCopied, isMobile]);

  return { isCopied, handleCopy };
}

export function useCopyMessageLink(messageId: string | null, conversationId?: string | null) {
  const [isLinkCopied, setIsLinkCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const isMobile = useIsMobileViewport();
  const rebasePath = useRebasePath();

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  const handleCopyLink = useCallback(() => {
    if (!messageId || isLinkCopied) return;
    const href = conversationId
      ? new URL(rebasePath(`/c/${encodeURIComponent(conversationId)}`), window.location.href).href
      : undefined;
    copyText(buildMessageDeepLink(messageId, href)).then(
      () => {
        setIsLinkCopied(true);
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setIsLinkCopied(false), 2000);
        if (isMobile) {
          showToast(<span className="text-ui">Link copied</span>, { duration: 1500 });
        }
      },
      () => toast.error("Could not copy message link"),
    );
  }, [messageId, conversationId, rebasePath, isLinkCopied, isMobile]);

  return { isLinkCopied, handleCopyLink };
}

/** The shared user/peer message timestamp and clipboard controls. */
export function MessageFooter({
  text,
  messageId,
  conversationId,
  createdAtS,
}: {
  text: string;
  messageId: string | null;
  conversationId?: string | null;
  createdAtS?: number;
}) {
  const timestamp = formatBubbleTimestamp(createdAtS);
  const { isCopied, handleCopy } = useCopyMessage(() => text);
  const { isLinkCopied, handleCopyLink } = useCopyMessageLink(messageId, conversationId);
  return (
    <div className="flex items-center justify-end gap-3 py-1 opacity-40 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
      {timestamp && (
        <span
          className="select-none text-[11px] leading-4 text-foreground/56"
          data-testid="message-timestamp"
        >
          {timestamp}
        </span>
      )}
      <MessageActions>
        {text && (
          <MessageAction
            tooltip="Copy"
            size="icon-xxs"
            onClick={handleCopy}
            componentId="chat.message.copy_user"
          >
            {isCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </MessageAction>
        )}
        <MessageAction
          tooltip={isLinkCopied ? "Copied!" : "Copy link"}
          size="icon-xxs"
          data-testid="copy-message-link"
          disabled={!messageId}
          onClick={handleCopyLink}
        >
          {isLinkCopied ? <CheckIcon size={14} /> : <Link2Icon size={14} />}
        </MessageAction>
      </MessageActions>
    </div>
  );
}
