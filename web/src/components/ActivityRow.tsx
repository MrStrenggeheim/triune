// Modified for Triune.
import { useId, useRef, useState, type ReactNode } from "react";
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
import "@/components/composer/composerShelves.css";

/** Shared unboxed activity disclosure for messages, agents and shell history. */
export function ActivityRow({
  icon,
  title,
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
  summary,
  expanded: controlledExpanded,
  onExpandedChange,
}: {
  icon: ReactNode;
  title: ReactNode;
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
  summary?: ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
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
  const name = typeof title === "string" ? title : "resource";
  const titleContent = (
    <span className="min-w-0 truncate" title={typeof title === "string" ? title : undefined}>
      {title}
    </span>
  );
  const row = (
    <div
      data-resource-row=""
      className={`resource-row ${message ? "gap-2.5" : "density-row gap-2 rounded-[var(--radius-md)] px-2 hover:bg-[var(--workspace-hover-on-content)]"} flex min-w-0 items-center text-sm ${selected ? "bg-[var(--workspace-hover-on-content)] ring-1 ring-ring" : ""}`}
      onClick={(event) => {
        if (!(event.target instanceof Element) || event.target.closest("button, a")) return;
        if (!event.currentTarget.contains(event.target)) return;
        if (window.getSelection()?.isCollapsed === false) return;
        onOpen?.();
      }}
    >
      <span
        className={`resource-icon flex shrink-0 items-center justify-center text-primary [&_svg]:size-7 ${message ? "size-7" : "size-9 rounded-[var(--radius-md)] bg-primary/5"}`}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        {onOpen ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={typeof title === "string" ? title : undefined}
            aria-description={
              descriptionText ?? (typeof description === "string" ? description : undefined)
            }
            className="h-auto w-full min-w-0 justify-start rounded-none p-0 text-left font-medium hover:bg-transparent"
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
        )}
        {(!message || !expanded) && (
          <div
            className={`resource-description min-w-0 ${message ? "line-clamp-1 text-sm text-foreground [&_p]:my-0" : "truncate text-xs text-muted-foreground"}`}
            title={descriptionText ?? (typeof description === "string" ? description : undefined)}
          >
            {summary ?? description ?? preview ?? "\u00a0"}
          </div>
        )}
      </div>
      {status && (
        <span className="flex shrink-0 items-center justify-end text-xs">
          {onStop ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={`Actions for ${name}`}
                  disabled={stopping}
                  className="resource-status h-auto rounded-4xl p-0 font-normal"
                  onPointerDown={(event) => {
                    pointerType.current = event.pointerType;
                    if (event.pointerType === "mouse" && event.button === 0) event.preventDefault();
                  }}
                  onClick={(event) => {
                    if (event.detail > 0 && pointerType.current === "mouse") void stop();
                  }}
                >
                  <span className="resource-status-label">{status}</span>
                  <Badge
                    variant="destructive"
                    className="resource-stop-label text-xs font-normal"
                    aria-hidden="true"
                  >
                    <SquareIcon className="size-3 fill-current" aria-hidden="true" />
                    {stopping ? "Stopping…" : "Stop"}
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
              aria-label={expanded ? "Collapse activity" : "Expand activity"}
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
  const openingRow = onStop ? (
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
      className={`activity-row min-w-0 text-sm ${message ? "border-l-2 border-primary/60 py-1 pl-2.5 sm:pl-3" : ""}`}
    >
      {openingRow}
      {children && (
        <div
          id={contentId}
          hidden={!expanded}
          className="min-w-0 pt-1 pl-9 text-foreground [&_p]:my-1"
        >
          {expanded && children}
        </div>
      )}
    </div>
  );
}
