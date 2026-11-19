// Modified for Triune.
import { ChatSearchRevealContext } from "@/lib/chatSearchHighlights";
import { useTranscriptDisclosureAnchor } from "@/hooks/useTranscriptDisclosureAnchor";
import { useContext, useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/lib/notifications";
import { Link } from "@/lib/routing";
import { cn } from "@/lib/utils";
import "@/components/composer/composerShelves.css";
import "./ActivityRow.css";
import ReactMarkdown from "react-markdown";

function InlinePreviewText({ children }: { children?: ReactNode }) {
  return <span>{children}</span>;
}
const PREVIEW_COMPONENTS = { p: InlinePreviewText, a: InlinePreviewText };

/** Shared unboxed activity disclosure for messages, agents and shell history. */
export function ActivityRow({
  icon,
  title,
  titleDetail,
  status,
  preview,
  children,
  onOpen,
  description,
  selected,
  actions,
  onStop,
  href,
  descriptionText,
  presentation = "resource",
  entry = false,
  entryLabel,
  summary,
  expanded: controlledExpanded,
  onExpandedChange,
  keepMounted = false,
  keepSummaryWhenExpanded = false,
  searchItemIds,
}: {
  icon: ReactNode;
  title: ReactNode;
  titleDetail?: ReactNode;
  status?: ReactNode;
  preview?: string;
  children?: ReactNode;
  /** A two-line resource entry with its actions outside the opening target. */
  onOpen?: () => void;
  description?: ReactNode;
  selected?: boolean;
  actions?: ReactNode;
  onStop?: () => Promise<void>;
  href?: string;
  descriptionText?: string;
  presentation?: "resource" | "message";
  /** Fixed two-line header used by agent and shell entries. */
  entry?: boolean;
  /** Spoken identity for an entry whose visible title contains markup. */
  entryLabel?: string;
  summary?: ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Forms retain their local drafts while the disclosure is folded. */
  keepMounted?: boolean;
  /** Compact agent cards retain their latest-message line while details are open. */
  keepSummaryWhenExpanded?: boolean;
  searchItemIds?: readonly string[];
}) {
  const preserveDisclosure = useTranscriptDisclosureAnchor();
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const searchReveal = useContext(ChatSearchRevealContext);
  const revealRequest = searchReveal?.revealRequest;
  const searchRequest =
    revealRequest && searchItemIds?.includes(revealRequest.itemId)
      ? `${revealRequest.itemId}:${revealRequest.revision}`
      : null;
  const expandedChange = useRef(onExpandedChange);
  expandedChange.current = onExpandedChange;
  useLayoutEffect(() => {
    if (searchRequest) {
      setLocalExpanded(true);
      expandedChange.current?.(true);
    }
  }, [searchRequest]);
  const contentId = useId();
  const message = presentation === "message";
  const [stopping, setStopping] = useState(false);
  const pending = useRef(false);
  const pointerType = useRef("");
  async function stop() {
    if (!onStop || pending.current) return;
    pending.current = true;
    setStopping(true);
    try {
      await onStop();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      setStopping(false);
    }
  }
  const name = entryLabel ?? (typeof title === "string" ? title : "resource");
  const disclosure = expanded ? "Collapse activity" : "Expand activity";
  const titleContent = (
    <span className="min-w-0 truncate" title={typeof title === "string" ? title : undefined}>
      {title}
    </span>
  );
  const heading =
    onOpen && !entry ? (
      <Button
        type="button"
        variant="ghost"
        size={entry ? "sm" : undefined}
        aria-label={typeof title === "string" ? title : undefined}
        aria-description={
          descriptionText ?? (typeof description === "string" ? description : undefined)
        }
        className={`h-auto ${titleDetail ? "w-auto max-w-[55%] shrink" : "w-full"} min-w-0 justify-start rounded-none p-0 text-left font-medium hover:bg-transparent`}
        onClick={href ? undefined : onOpen}
        asChild={!!href}
      >
        {href ? (
          <Link
            to={href}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                event.stopPropagation();
                return;
              }
              event.preventDefault();
              onOpen();
            }}
          >
            {titleContent}
          </Link>
        ) : (
          titleContent
        )}
      </Button>
    ) : (
      <div
        className="flex min-w-0 items-center gap-1.5 truncate"
        title={typeof title === "string" ? title : undefined}
      >
        {title}
      </div>
    );

  const row = (
    <div
      data-resource-row=""
      className={cn(
        "resource-row flex min-w-0 items-center text-sm",
        message && "activity-message-header",
        entry
          ? "activity-entry-header"
          : message
            ? "gap-2.5"
            : "density-row gap-2 rounded-[var(--radius-md)] hover:bg-[var(--workspace-hover-on-content)]",
        selected && "bg-[var(--workspace-hover-on-content)] ring-1 ring-ring",
      )}
      onClick={(event) => {
        if (entry || !(event.target instanceof Element) || event.target.closest("button, a"))
          return;
        if (!event.currentTarget.contains(event.target)) return;
        if (window.getSelection()?.isCollapsed === false) return;
        onOpen?.();
      }}
    >
      <span
        className={`resource-icon flex shrink-0 items-center justify-center text-primary [&_svg]:size-7 ${message ? "size-7" : entry ? "size-9" : "size-9 rounded-[var(--radius-md)] bg-primary/5"}`}
      >
        {icon}
      </span>
      <div className={`min-w-0 flex-1 ${message ? "activity-message-text" : "resource-text"}`}>
        {titleDetail ? (
          <div className="flex min-w-0 items-center gap-1">
            {heading}
            <span className="resource-title-detail min-w-0 flex-1 truncate">{titleDetail}</span>
          </div>
        ) : (
          heading
        )}
        {(!message || !expanded || keepSummaryWhenExpanded) && (
          <div
            className={`resource-description min-w-0 ${message ? "line-clamp-1 text-sm text-foreground [&_p]:my-0" : "truncate text-xs text-muted-foreground"}`}
            title={descriptionText ?? (typeof description === "string" ? description : undefined)}
          >
            {typeof (summary ?? description ?? preview) === "string" ? (
              <ReactMarkdown
                skipHtml
                allowedElements={["p", "strong", "em", "code", "del", "a"]}
                unwrapDisallowed
                components={PREVIEW_COMPONENTS}
              >
                {String(summary ?? description ?? preview)}
              </ReactMarkdown>
            ) : (
              (summary ?? description ?? preview ?? "\u00a0")
            )}
          </div>
        )}
      </div>
      {status && (
        <span className="activity-status-slot flex shrink-0 items-center justify-end text-xs">
          {onStop ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={`${entry ? "Stop actions" : "Actions"} for ${name}`}
                  aria-describedby={`${contentId}-status`}
                  disabled={stopping}
                  loading={stopping}
                  className="resource-status h-auto rounded-4xl p-0 font-normal"
                  onPointerDown={(event) => {
                    pointerType.current = event.pointerType;
                    if (event.pointerType === "mouse" && event.button === 0) event.preventDefault();
                  }}
                  onClick={(event) => {
                    if (event.detail > 0 && pointerType.current === "mouse") void stop();
                  }}
                >
                  <span id={`${contentId}-status`} className="resource-status-label">
                    {status}
                  </span>
                  <Badge
                    variant="destructive"
                    className="resource-stop-label text-xs font-normal"
                    aria-hidden="true"
                  >
                    <SquareIcon className="size-3 fill-current" aria-hidden="true" />
                    <span className="resource-stop-text">Stop</span>
                  </Badge>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="rounded-[var(--radius-lg)]">
                <DropdownMenuItem
                  variant="destructive"
                  disabled={stopping}
                  onSelect={() => void stop()}
                >
                  <SquareIcon className="fill-current" aria-hidden="true" />
                  {stopping ? "Stopping…" : `Stop ${name}`}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            status
          )}
        </span>
      )}
      {(actions || children) && (
        <span className="resource-actions flex shrink-0 items-center gap-1">
          {actions}
          {children && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              tooltip={false}
              aria-label={entry ? `${disclosure} · ${name}` : disclosure}
              aria-expanded={expanded}
              aria-controls={contentId}
              onClick={() => {
                setLocalExpanded(!expanded);
                onExpandedChange?.(!expanded);
              }}
            >
              <ChevronRightIcon
                aria-hidden="true"
                className={`size-3.5 transition-none ${expanded ? "rotate-90" : ""}`}
              />
            </Button>
          )}
        </span>
      )}
    </div>
  );
  const openingRow =
    onStop && !entry ? (
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="rounded-[var(--radius-lg)]">
          <ContextMenuItem variant="destructive" disabled={stopping} onSelect={() => void stop()}>
            <SquareIcon className="fill-current" aria-hidden="true" />
            {stopping ? "Stopping…" : `Stop ${name}`}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ) : (
      row
    );

  return (
    <div
      onClickCapture={preserveDisclosure}
      className={cn(
        "activity-row min-w-0 text-sm",
        message ? "activity-row--message" : "activity-row--resource",
        entry && "activity-entry",
        message && !entry && "border-l-2 border-primary/60 py-1 pl-2.5 sm:pl-3",
      )}
    >
      {openingRow}
      {children && (
        <div
          id={contentId}
          hidden={!expanded}
          className={`min-w-0 pt-1 pl-9 text-foreground [&_p]:my-1 ${message ? "activity-message-body" : ""}`}
        >
          {(expanded || keepMounted) && children}
        </div>
      )}
    </div>
  );
}
