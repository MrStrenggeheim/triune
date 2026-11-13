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
}: {
  icon: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  preview?: string;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
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
