// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useState } from "react";
import { InfoIcon, SquareTerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RuntimeNotice } from "@/hooks/useRuntimeNotices";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";
import { COMPOSER_WORKSPACE_COLLAPSED_LABEL_CLASS } from "./ChatComposer";

function noticeColor(severity: RuntimeNotice["severity"]) {
  return severity === "error"
    ? "text-destructive"
    : severity === "warning"
      ? "text-warning"
      : "text-primary";
}

export function RuntimeNoticeIndicator({
  conversationId,
  notices,
  onDismiss,
}: {
  conversationId: string | null;
  notices: RuntimeNotice[];
  onDismiss: (notice: RuntimeNotice) => void;
}) {
  const [open, setOpen] = useState(false);
  const workbench = useWorkbenchActions();
  useEffect(() => setOpen(false), [conversationId]);
  useEffect(() => {
    if (!notices.length) setOpen(false);
  }, [notices.length]);
  if (!notices.length || !conversationId) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          type="button"
          className="gap-1 px-1 font-normal tabular-nums"
          aria-label={`Notices: ${notices.length}`}
        >
          <InfoIcon
            className={`size-3.5 ${noticeColor(notices.some((notice) => notice.severity === "error") ? "error" : notices.some((notice) => notice.severity === "warning") ? "warning" : "info")}`}
          />
          <span
            data-workspace-collapse-label=""
            className={COMPOSER_WORKSPACE_COLLAPSED_LABEL_CLASS}
          >
            Notices
          </span>
          <span>{notices.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={8}
        aria-label="Agent notices"
        className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto p-2"
      >
        <ul className="flex flex-col gap-2">
          {notices.map((notice) => (
            <li key={notice.id} className="rounded-md p-1 text-ui">
              <div className="flex items-center gap-1.5 font-semibold">
                <InfoIcon className={`size-4 shrink-0 ${noticeColor(notice.severity)}`} />
                <span className="min-w-0">
                  {notice.provider ? `${notice.provider} · ` : ""}
                  {notice.title}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                {notice.message}
              </p>
              {notice.reset_at != null && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Resets {new Date(notice.reset_at * 1000).toLocaleString()}
                </p>
              )}
              <div className="mt-2 flex items-center gap-1">
                {workbench && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      workbench.openView(
                        { kind: "agent-terminal", conversationId, title: "Agent CLI" },
                        { beside: true },
                      );
                      setOpen(false);
                    }}
                  >
                    <SquareTerminalIcon />
                    Open Agent CLI
                  </Button>
                )}
                <Button type="button" variant="ghost" size="xs" onClick={() => onDismiss(notice)}>
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
