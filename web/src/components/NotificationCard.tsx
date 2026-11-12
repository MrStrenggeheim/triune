// Modified for Triune.
import type { ReactNode } from "react";
import { CheckIcon, CircleAlertIcon, InfoIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { absoluteTime, relativeTime } from "@/lib/relativeTime";
import {
  hideNotification,
  removeNotification,
  runNotificationAction,
  setNotificationPaused,
  type NotificationEntry,
} from "@/lib/notifications";

function content(value: NotificationEntry["title"]): ReactNode {
  return typeof value === "function" ? value() : value;
}

/** The same presentation is used in the popup stack and notification history. */
export function NotificationCard({
  entry,
  history = false,
}: {
  entry: NotificationEntry;
  history?: boolean;
}) {
  const active = entry.type === "loading" || entry.progress?.active === true;
  if (entry.jsx && entry.dismissible === false) {
    return (
      <div data-testid={entry.testId} data-notification-id={entry.id} data-notification-card>
        {entry.jsx}
      </div>
    );
  }
  const Icon = active
    ? Loader2Icon
    : entry.type === "success"
      ? CheckIcon
      : entry.type === "error" || entry.type === "warning"
        ? CircleAlertIcon
        : InfoIcon;
  const action = (kind: "action" | "cancel") => {
    const value = entry[kind];
    if (!value) return null;
    if (typeof value === "object" && "onClick" in value)
      return (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={entry.actionPending}
          onClick={(event) => void runNotificationAction(entry.id, kind, event)}
        >
          {value.label}
        </Button>
      );
    return value;
  };
  return (
    <article
      data-testid={entry.testId}
      data-notification-id={entry.id}
      data-notification-card
      role={history ? undefined : entry.type === "error" ? "alert" : "status"}
      aria-busy={active || entry.actionPending || undefined}
      className={cn(
        "density-row grid grid-cols-[1rem_minmax(0,1fr)_1.5rem] items-start text-ui",
        !history &&
          "rounded-xl bg-popover text-popover-foreground shadow-menu ring-1 ring-foreground/10",
      )}
      onPointerEnter={() => setNotificationPaused(entry.id, true, "pointer")}
      onPointerLeave={() => setNotificationPaused(entry.id, false, "pointer")}
      onFocusCapture={() => setNotificationPaused(entry.id, true, "focus")}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setNotificationPaused(entry.id, false, "focus");
      }}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-1 size-4 shrink-0 text-muted-foreground",
          active && "animate-spin text-primary motion-reduce:animate-none",
          entry.type === "error" && "text-destructive",
          entry.type === "warning" && "text-warning",
          entry.type === "success" && "text-success",
        )}
      />
      <div className="min-w-0 space-y-[var(--list-gap)] break-words [overflow-wrap:anywhere]">
        {entry.title && <div className="font-medium leading-5">{content(entry.title)}</div>}
        {entry.description && (
          <div className="text-sm leading-5 text-muted-foreground">
            {content(entry.description)}
          </div>
        )}
        {entry.jsx}
      </div>
      {entry.dismissible !== false && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="-mt-0.5 text-muted-foreground"
          aria-label={history && !active ? "Remove notification" : "Hide notification"}
          onClick={() =>
            history && !active ? removeNotification(entry.id) : hideNotification(entry.id)
          }
        >
          <XIcon className="size-3.5" />
        </Button>
      )}
      {entry.progress && (
        <div className="col-start-2 col-end-4 space-y-[var(--list-gap)]" data-notification-progress>
          <div
            role="progressbar"
            aria-label={entry.progress.label || "Activity progress"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              entry.progress.value === undefined
                ? undefined
                : Math.min(100, Math.max(0, entry.progress.value))
            }
            className="h-0.5 overflow-hidden rounded-[1px] bg-foreground/10"
          >
            <div
              className={cn(
                "h-full bg-primary transition-[width] duration-150 motion-reduce:transition-none",
                entry.progress.value === undefined && "w-1/3 animate-pulse",
              )}
              style={
                entry.progress.value === undefined
                  ? undefined
                  : { width: `${Math.min(100, Math.max(0, entry.progress.value))}%` }
              }
            />
          </div>
          {entry.progress.label && (
            <p className="text-xs tabular-nums text-muted-foreground">{entry.progress.label}</p>
          )}
        </div>
      )}
      {(entry.action || entry.cancel || history) && (
        <div className="col-start-2 col-end-4 flex flex-wrap items-center justify-end gap-[var(--list-row-gap)]">
          {history && (
            <time
              className="mr-auto text-10 text-muted-foreground"
              dateTime={new Date(entry.createdAt).toISOString()}
              title={absoluteTime(entry.createdAt)}
            >
              {relativeTime(entry.createdAt)}
            </time>
          )}
          {action("cancel")}
          {action("action")}
        </div>
      )}
    </article>
  );
}
