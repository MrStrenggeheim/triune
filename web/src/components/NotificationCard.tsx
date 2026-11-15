// Modified for Triune.
import type { ReactNode } from "react";
import { CheckIcon, CircleAlertIcon, InfoIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CloseButton } from "@/components/CloseButton";
import { cn } from "@/lib/utils";
import { absoluteTime, relativeTime } from "@/lib/relativeTime";
import {
  hideNotification,
  removeNotification,
  runNotificationAction,
  setNotificationPaused,
  type NotificationEntry,
} from "@/lib/notifications";
import "./notifications.css";

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
        "notification-card density-row text-ui",
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
      <span className="notification-icon" aria-hidden="true">
        <Icon
          className={cn(
            "size-4 shrink-0 text-muted-foreground",
            active && "animate-spin text-primary motion-reduce:animate-none",
            entry.type === "error" && "text-destructive",
            entry.type === "warning" && "text-warning",
            entry.type === "success" && "text-success",
          )}
        />
      </span>
      <div className="notification-body min-w-0 space-y-[var(--popup-text-gap)] break-words [overflow-wrap:anywhere]">
        {entry.title && (
          <div className="notification-title font-medium leading-5">{content(entry.title)}</div>
        )}
        {entry.description && (
          <div className="notification-description text-sm leading-5 text-muted-foreground">
            {content(entry.description)}
          </div>
        )}
        {entry.jsx}
      </div>
      {entry.dismissible !== false && (
        <CloseButton
          className="notification-dismiss"
          aria-label={history && !active ? "Remove notification" : "Hide notification"}
          onClick={() =>
            history && !active ? removeNotification(entry.id) : hideNotification(entry.id)
          }
        />
      )}
      {entry.progress && (
        <div
          className="notification-progress space-y-[var(--popup-text-gap)]"
          data-notification-progress
        >
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
        <div className="notification-footer">
          {history && (
            <time
              className="text-10 text-muted-foreground"
              dateTime={new Date(entry.createdAt).toISOString()}
              title={absoluteTime(entry.createdAt)}
            >
              {relativeTime(entry.createdAt)}
            </time>
          )}
          {(entry.cancel || entry.action) && (
            <div className="notification-actions">
              {action("cancel")}
              {action("action")}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
