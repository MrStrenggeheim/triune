// Modified for Triune.
import { useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, SquareIcon } from "lucide-react";
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
}) {
  const [expanded, setExpanded] = useState(false);
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
  if (onOpen || description !== undefined) {
    const name = typeof title === "string" ? title : "resource";
    const titleContent = (
      <span className="min-w-0 truncate" title={typeof title === "string" ? title : undefined}>
        {title}
      </span>
    );
    const row = (
      <div
        data-resource-row=""
        className={`resource-row density-row flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] px-2 text-sm hover:bg-[var(--workspace-hover-on-content)] ${selected ? "bg-[var(--workspace-hover-on-content)] ring-1 ring-ring" : ""}`}
        onClick={(event) => {
          if (!(event.target instanceof Element) || event.target.closest("button, a")) return;
          if (!event.currentTarget.contains(event.target)) return;
          if (window.getSelection()?.isCollapsed === false) return;
          onOpen?.();
        }}
      >
        <span className="resource-icon flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-primary/5 text-primary [&_svg]:size-7">
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
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
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
              className="min-w-0 truncate font-medium"
              title={typeof title === "string" ? title : undefined}
            >
              {title}
            </div>
          )}
          <div
            className="resource-description min-w-0 truncate text-xs text-muted-foreground"
            title={descriptionText ?? (typeof description === "string" ? description : undefined)}
          >
            {description || "\u00a0"}
          </div>
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
                      if (event.pointerType === "mouse" && event.button === 0)
                        event.preventDefault();
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
        {actions && (
          <span className="resource-actions flex shrink-0 items-center gap-1">{actions}</span>
        )}
      </div>
    );
    return onStop ? (
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
  }
  return (
    <div className="activity-row min-w-0 py-1 text-sm">
      <div className="flex min-h-7 items-center gap-1.5">
        {children && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={expanded ? "Collapse activity" : "Expand activity"}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </Button>
        )}
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {status && <span className="shrink-0 text-xs text-muted-foreground">{status}</span>}
      </div>
      {!expanded && preview && (
        <p
          className={`${children ? "ml-8" : "ml-5"} line-clamp-3 whitespace-pre-wrap break-words text-foreground`}
        >
          {preview}
        </p>
      )}
      {expanded && <div className="ml-8 min-w-0 border-l border-border pl-3">{children}</div>}
    </div>
  );
}
