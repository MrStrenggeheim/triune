// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useState } from "react";
import { InfoIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeaderActionButton } from "@/components/HeaderActionButton";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { RuntimeNotice } from "@/hooks/useRuntimeNotices";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";

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
  active = true,
}: {
  conversationId: string | null;
  notices: RuntimeNotice[];
  onDismiss: (notice: RuntimeNotice) => void;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const workbench = useWorkbenchActions();
  useEffect(() => setOpen(false), [conversationId]);
  useEffect(() => {
    if (!notices.length || !active) setOpen(false);
  }, [notices.length, active]);
  if (!notices.length || !conversationId) return null;
  return (
    <Popover open={active && open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <HeaderActionButton className="relative" aria-label={`Notices: ${notices.length}`}>
          <InfoIcon
            className={`size-4 ${noticeColor(notices.some((notice) => notice.severity === "error") ? "error" : notices.some((notice) => notice.severity === "warning") ? "warning" : "info")}`}
          />
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-[9px] leading-3.5 text-primary-foreground"
          >
            {notices.length}
          </span>
        </HeaderActionButton>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={8}
        aria-label="Agent notices"
        onCloseAutoFocus={(event) => {
          if (!active) event.preventDefault();
        }}
        className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto gap-[var(--popup-item-gap)] p-[var(--popup-inset)]"
      >
        <ul className="flex flex-col gap-[var(--popup-item-gap)]">
          {notices.map((notice) => (
            <li key={notice.id} className="flex flex-col gap-[var(--popup-text-gap)] text-ui">
              <PopoverTitle className="flex items-center gap-1.5">
                <InfoIcon className={`size-4 shrink-0 ${noticeColor(notice.severity)}`} />
                <span className="min-w-0 flex-1">
                  {notice.provider ? `${notice.provider} · ` : ""}
                  {notice.title}
                </span>
                <HeaderActionButton
                  aria-label={`Dismiss ${notice.title}`}
                  tooltip="Dismiss"
                  onClick={() => onDismiss(notice)}
                >
                  <XIcon aria-hidden="true" />
                </HeaderActionButton>
              </PopoverTitle>
              <PopoverDescription className="whitespace-pre-wrap break-words">
                {notice.message}
              </PopoverDescription>
              {notice.reset_at != null && (
                <p className="text-xs text-muted-foreground">
                  Last reported reset: {new Date(notice.reset_at * 1000).toLocaleString()}
                  {notice.reset_at * 1000 <= Date.now() && " · Current availability unconfirmed"}
                </p>
              )}
              {workbench && (
                <div className="flex flex-wrap items-center gap-[var(--popup-footer-gap)]">
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
                </div>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
