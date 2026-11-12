// Modified for Triune.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
} from "react";
import { BellIcon, CheckCheckIcon, EyeIcon, EyeOffIcon, Loader2Icon, XIcon } from "lucide-react";
import type { ToasterProps } from "sonner";
import { Button } from "@/components/ui/button";
import { HeaderActionButton } from "./HeaderActionButton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NotificationCard } from "./NotificationCard";
import {
  clearCompletedNotifications,
  getNotificationSnapshot,
  hideNotification,
  setNotificationCenterOpen,
  setShowReadNotifications,
  subscribeNotifications,
} from "@/lib/notifications";

function collapseCenter() {
  setNotificationCenterOpen(false);
  for (const entry of getNotificationSnapshot().entries) {
    if (entry.dismissible !== false) hideNotification(entry.id);
  }
}

const NotificationLayout = createContext<{
  width: number;
  bottom: string;
  ownerId?: string | null;
  openFor: (id: string) => void;
  closeFor: (id: string) => void;
}>({
  width: 320,
  bottom: "calc(1rem + var(--omnigent-inset-bottom, 0px))",
  openFor: () => setNotificationCenterOpen(true),
  closeFor: collapseCenter,
});

export function NotificationLayoutProvider({
  children,
  width,
  bottom,
}: {
  children: ReactNode;
  width: number;
  bottom: string;
}) {
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const owner = useRef<string | null>(null);
  const openFor = useCallback((id: string) => {
    owner.current = id;
    setOwnerId(id);
    setNotificationCenterOpen(true);
  }, []);
  const closeFor = useCallback((id: string) => {
    if (owner.current !== id) return;
    owner.current = null;
    setOwnerId(null);
    collapseCenter();
  }, []);
  const value = useMemo(
    () => ({ width, bottom, ownerId, openFor, closeFor }),
    [width, bottom, ownerId, openFor, closeFor],
  );
  return <NotificationLayout.Provider value={value}>{children}</NotificationLayout.Provider>;
}

function useNotificationLayout(): CSSProperties {
  const { width } = useContext(NotificationLayout);
  return { width: Math.round(width), maxWidth: "calc(100vw - 2rem)" };
}

export function NotificationBell() {
  const id = useId();
  const { ownerId, openFor, closeFor } = useContext(NotificationLayout);
  useEffect(() => () => closeFor(id), [id, closeFor]);
  const { entries, centerOpen, showRead } = useSyncExternalStore(
    subscribeNotifications,
    getNotificationSnapshot,
    getNotificationSnapshot,
  );
  const style = useNotificationLayout();
  const unread = entries.filter((entry) => entry.unread).length;
  const newest = [...entries].reverse();
  const required = newest.filter((entry) => entry.dismissible === false);
  const running = newest.filter(
    (entry) => entry.dismissible !== false && (entry.progress?.active || entry.type === "loading"),
  );
  const completed = newest.filter(
    (entry) => entry.dismissible !== false && !entry.progress?.active && entry.type !== "loading",
  );
  const recent = completed.filter(
    (entry) =>
      showRead ||
      entry.unread ||
      entry.seenInCurrentVisit ||
      entry.actionPending ||
      entry.action ||
      entry.cancel ||
      entry.jsx,
  );
  const hasHistory = required.length > 0 || running.length > 0 || recent.length > 0;
  const onOpenChange = (open: boolean) => {
    if (open) openFor(id);
    else closeFor(id);
  };
  return (
    <TooltipProvider>
      <Popover
        open={centerOpen && (ownerId === undefined || ownerId === id)}
        onOpenChange={onOpenChange}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <PopoverTrigger asChild>
                <HeaderActionButton
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Notifications"
                  aria-description={`${unread} unread, ${running.length} activities in progress`}
                  className="relative text-muted-foreground"
                >
                  <BellIcon className="size-4" />
                  {running.length > 0 && (
                    <Loader2Icon
                      aria-hidden
                      data-icon-size="status"
                      className="absolute -bottom-0.5 -right-0.5 size-2.5 animate-spin rounded-full bg-background text-primary motion-reduce:animate-none"
                    />
                  )}
                  {unread > 0 && (
                    <span
                      aria-hidden
                      className="absolute -top-1 -right-1 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-[9px] leading-3.5 text-primary-foreground"
                    >
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                  <span className="sr-only">
                    {unread} unread, {running.length} activities in progress
                  </span>
                </HeaderActionButton>
              </PopoverTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Notifications{running.length ? ` · ${running.length} in progress` : ""}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          sideOffset={12}
          collisionPadding={16}
          style={style}
          className="z-[80] gap-0 overflow-hidden p-0"
          role="dialog"
          aria-label="Notifications"
        >
          <header className="flex h-[var(--density-header-height)] shrink-0 items-center gap-[var(--list-gap)] border-b border-border px-[var(--list-row-padding-inline)]">
            <h2 className="mr-auto font-medium">Notifications</h2>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Show read notifications"
              aria-pressed={showRead}
              tooltip={showRead ? "Hide read notifications" : "Show read notifications"}
              tooltipDescription="Activities and available actions stay visible."
              onClick={() => setShowReadNotifications(!showRead)}
            >
              {showRead ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Clear completed notifications"
              title="Clear completed notifications"
              onClick={clearCompletedNotifications}
              disabled={!completed.length}
            >
              <CheckCheckIcon className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Close notifications"
              onClick={() => onOpenChange(false)}
            >
              <XIcon className="size-4" />
            </Button>
          </header>
          <div
            className="max-h-[60vh] overflow-y-auto overscroll-contain"
            aria-label="Notification history"
          >
            {!hasHistory && (
              <p className="px-[var(--list-row-padding-inline)] py-6 text-center text-sm text-muted-foreground">
                {entries.length ? "No unread notifications" : "No notifications yet"}
              </p>
            )}
            {required.length > 0 && (
              <div>
                <h3 className="px-[var(--list-row-padding-inline)] pt-[var(--list-row-padding-block)] pb-[var(--list-gap)] text-10 font-medium uppercase tracking-wide text-muted-foreground">
                  Needs attention
                </h3>
                <div className="divide-y divide-border">
                  {required.map((entry) => (
                    <NotificationCard key={entry.id} entry={entry} history />
                  ))}
                </div>
              </div>
            )}
            {running.length > 0 && (
              <div>
                <h3 className="px-[var(--list-row-padding-inline)] pt-[var(--list-row-padding-block)] pb-[var(--list-gap)] text-10 font-medium uppercase tracking-wide text-muted-foreground">
                  In progress
                </h3>
                <div className="divide-y divide-border">
                  {running.map((entry) => (
                    <NotificationCard key={entry.id} entry={entry} history />
                  ))}
                </div>
              </div>
            )}
            {recent.length > 0 && (
              <div>
                {running.length > 0 && (
                  <h3 className="px-[var(--list-row-padding-inline)] pt-[var(--list-row-padding-block)] pb-[var(--list-gap)] text-10 font-medium uppercase tracking-wide text-muted-foreground">
                    Recent
                  </h3>
                )}
                <div className="divide-y divide-border">
                  {recent.map((entry) => (
                    <NotificationCard key={entry.id} entry={entry} history />
                  ))}
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

/** Compatibility entry point for the app's existing Toaster mount. */
export function NotificationToasts(_props: ToasterProps) {
  const { entries, centerOpen } = useSyncExternalStore(
    subscribeNotifications,
    getNotificationSnapshot,
    getNotificationSnapshot,
  );
  const { bottom } = useContext(NotificationLayout);
  const style = useNotificationLayout();
  const required = entries.filter((entry) => entry.dismissible === false && entry.visible);
  const ordinary = entries
    .filter((entry) => entry.dismissible !== false && entry.visible)
    .slice(-3)
    .reverse();
  return (
    <aside
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-auto fixed right-4 z-[70] flex max-h-[calc(var(--omnigent-viewport-height,100dvh)-5rem)] flex-col gap-[var(--list-row-gap)] overflow-y-auto overscroll-contain p-px"
      style={{
        ...style,
        display: centerOpen || (!required.length && !ordinary.length) ? "none" : undefined,
        bottom: `calc(${bottom} + max(0px, 100lvh - var(--omnigent-viewport-height, 100lvh)))`,
      }}
    >
      {!centerOpen && required.map((entry) => <NotificationCard key={entry.id} entry={entry} />)}
      {!centerOpen && ordinary.map((entry) => <NotificationCard key={entry.id} entry={entry} />)}
    </aside>
  );
}
