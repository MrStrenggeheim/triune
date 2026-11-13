// Modified for Triune.
import { useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

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
}) {
  const [expanded, setExpanded] = useState(false);
  if (onOpen) {
    return (
      <div
        className={`density-row flex min-w-0 items-center rounded-md text-sm hover:bg-[var(--workspace-hover-on-content)] ${selected ? "bg-[var(--workspace-hover-on-content)] ring-1 ring-ring" : ""}`}
        onClick={(event) => {
          if (!(event.target instanceof Element) || event.target.closest("button, a")) return;
          onOpen();
        }}
      >
        <Button
          type="button"
          variant="ghost"
          aria-label={typeof title === "string" ? title : undefined}
          aria-description={typeof description === "string" ? description : undefined}
          className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-none p-0 text-left font-normal hover:bg-transparent"
          onClick={onOpen}
        >
          <span className="shrink-0 text-muted-foreground">{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{title}</span>
            <span className="block truncate text-xs text-muted-foreground">{description}</span>
          </span>
        </Button>
        {status && <span className="flex shrink-0 items-center gap-1.5 text-xs">{status}</span>}
      </div>
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
