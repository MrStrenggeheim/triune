// Modified for Triune.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
  type ComponentProps,
} from "react";
import * as PopoverPrimitive from "radix-ui/popover";
import { BellIcon, CheckCheckIcon, EyeIcon, EyeOffIcon, Loader2Icon } from "lucide-react";
import type { ToasterProps } from "sonner";
import { CloseButton } from "@/components/CloseButton";
import { HeaderActionButton } from "./HeaderActionButton";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { getPopupRowOffsets, useAnchoredPopupBounds } from "@/components/ui/anchored-popup";
import { getEmbedRoot } from "@/lib/host";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NotificationCard } from "./NotificationCard";
import {
  clearCompletedNotifications,
  getNotificationSnapshot,
  setNotificationCenterOpen,
  setShowReadNotifications,
  subscribeNotifications,
} from "@/lib/notifications";

function collapseCenter() {
  setNotificationCenterOpen(false);
}

const NotificationLayout = createContext<{
  width: number;
  bottom: string;
  ownerId?: string | null;
  anchorBounds?: { top: number; right: number } | null;
  boundary?: HTMLElement | null;
  registerBell: (id: string, node: HTMLButtonElement | null) => void;
  openFor: (id: string) => void;
  closeFor: (id: string) => void;
}>({
  width: 320,
  bottom: "calc(1rem + var(--omnigent-inset-bottom, 0px))",
  registerBell: () => {},
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
  const [bells, setBells] = useState(new Map<string, HTMLButtonElement>());
  const [anchorBounds, setAnchorBounds] = useState<{ top: number; right: number } | null>(null);
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
  const registerBell = useCallback((id: string, node: HTMLButtonElement | null) => {
    setBells((previous) => {
      if (previous.get(id) === node || (!node && !previous.has(id))) return previous;
      const next = new Map(previous);
      if (node) next.set(id, node);
      else next.delete(id);
      return next;
    });
  }, []);
  useLayoutEffect(() => {
    // One layout owner observes bell/header changes, independently of notification count.
    const selectAnchor = () => {
      const visible = [...bells.values()].filter((bell) => {
        if (!bell.isConnected || bell.closest("[hidden], [inert]")) return false;
        const rect = bell.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth &&
          (bell.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true)
        );
      });
      visible.sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return a.top - b.top || b.right - a.right;
      });
      const bell = visible[0];
      const rect = bell?.getBoundingClientRect();
      const offset = bell ? (getPopupRowOffsets(bell)?.bottom ?? 12) : 12;
      const next = rect
        ? { top: rect.bottom + offset, right: window.innerWidth - rect.right }
        : null;
      setAnchorBounds((previous) =>
        previous?.top === next?.top && previous?.right === next?.right ? previous : next,
      );
      const currentOwner = owner.current && bells.get(owner.current);
      if (currentOwner && !visible.includes(currentOwner)) {
        owner.current = null;
        setOwnerId(null);
        collapseCenter();
      }
    };
    selectAnchor();
    const resize = new ResizeObserver(selectAnchor);
    const mutation = new MutationObserver(selectAnchor);
    const ancestors = new Set<Element>();
    for (const bell of bells.values()) {
      for (let node: Element | null = bell; node; node = node.parentElement) ancestors.add(node);
    }
    for (const node of ancestors) {
      resize.observe(node);
      mutation.observe(node, {
        attributes: true,
        attributeFilter: ["hidden", "style", "class", "inert", "data-list-density"],
      });
    }
    window.addEventListener("resize", selectAnchor);
    window.addEventListener("scroll", selectAnchor, true);
    window.visualViewport?.addEventListener("resize", selectAnchor);
    window.visualViewport?.addEventListener("scroll", selectAnchor);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", selectAnchor);
      window.removeEventListener("scroll", selectAnchor, true);
      window.visualViewport?.removeEventListener("resize", selectAnchor);
      window.visualViewport?.removeEventListener("scroll", selectAnchor);
    };
  }, [bells]);
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
    () => ({ width, bottom, ownerId, anchorBounds, boundary, registerBell, openFor, closeFor }),
    [width, bottom, ownerId, anchorBounds, boundary, registerBell, openFor, closeFor],
  );
  return (
    <NotificationLayout.Provider value={value}>
      <div
        ref={setBoundary}
        aria-hidden
        data-notification-boundary
        className="pointer-events-none fixed invisible"
        style={{
          top: "max(16px, var(--omnigent-inset-top, 0px))",
          right: "max(16px, var(--omnigent-safe-right, 0px))",
          bottom: "max(16px, var(--omnigent-inset-bottom, 0px))",
          left: "max(16px, var(--omnigent-safe-left, 0px))",
        }}
      />
      {children}
    </NotificationLayout.Provider>
  );
}

function useNotificationLayout(): CSSProperties {
  const { width } = useContext(NotificationLayout);
  return {
    width: Math.round(width),
    maxWidth:
      "calc(100vw - max(16px, var(--omnigent-safe-left, 0px)) - max(16px, var(--omnigent-safe-right, 0px)))",
  };
}

/** Notifications keep the owner's explicit end alignment through the shared collision helper. */
function NotificationPopupContent({
  className,
  style,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  const { boundary } = useContext(NotificationLayout);
  const bounds = useAnchoredPopupBounds(boundary ? 0 : 16, style, true, "bottom", 12);
  return (
    <PopoverPrimitive.Portal container={getEmbedRoot() ?? undefined}>
      <PopoverPrimitive.Content
        {...bounds}
        collisionBoundary={boundary}
        side="bottom"
        align="end"
        sideOffset={bounds.sideOffset}
        className={cn("text-ui outline-hidden", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export function NotificationBell() {
  const id = useId();
  const { ownerId, registerBell, openFor, closeFor } = useContext(NotificationLayout);
  const bellRef = useCallback(
    (node: HTMLButtonElement | null) => registerBell(id, node),
    [id, registerBell],
  );
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
        <TooltipProvider side="bottom">
          <PopoverTrigger asChild>
            <HeaderActionButton
              ref={bellRef}
              data-notification-bell
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Notifications"
              tooltip={
                running.length ? `Notifications · ${running.length} in progress` : "Notifications"
              }
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
        </TooltipProvider>
        <NotificationPopupContent
          style={{ ...style, maxHeight: "var(--radix-popper-available-height)" }}
          className="z-[80] flex flex-col gap-0 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-menu ring-1 ring-foreground/10"
          role="dialog"
          aria-label="Notifications"
        >
          <header className="notification-center-header shrink-0 border-b border-border">
            <h2 className="mr-auto font-medium">Notifications</h2>
            <HeaderActionButton
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
            </HeaderActionButton>
            <HeaderActionButton
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Clear completed notifications"
              title="Clear completed notifications"
              onClick={clearCompletedNotifications}
              disabled={!completed.length}
            >
              <CheckCheckIcon className="size-4" />
            </HeaderActionButton>
            <CloseButton aria-label="Close notifications" onClick={() => onOpenChange(false)} />
          </header>
          <div
            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain"
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
        </NotificationPopupContent>
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
  const { anchorBounds } = useContext(NotificationLayout);
  const style = useNotificationLayout();
  const bounds = useAnchoredPopupBounds(16, style);
  const left = `max(${bounds.collisionPadding.left}px, var(--omnigent-safe-left, 0px))`;
  const right = `max(${bounds.collisionPadding.right}px, var(--omnigent-safe-right, 0px))`;
  const top = anchorBounds
    ? `max(${bounds.collisionPadding.top}px, var(--omnigent-inset-top, 0px), ${anchorBounds.top}px)`
    : "calc(max(16px, var(--omnigent-inset-top, 0px)) + var(--density-header-height, 48px) + 12px)";
  const required = entries.filter((entry) => entry.dismissible === false && entry.visible);
  const ordinary = entries
    .filter((entry) => entry.dismissible !== false && entry.visible && !entry.previewSuppressed)
    .slice(-3)
    .reverse();
  return (
    <aside
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-auto fixed z-[70] flex flex-col"
      style={
        {
          ...bounds.style,
          display: centerOpen || (!required.length && !ordinary.length) ? "none" : undefined,
          top,
          right: anchorBounds
            ? `clamp(${right}, ${anchorBounds.right}px, calc(100vw - ${style.width}px - ${left}))`
            : right,
          "--notification-available-height": `max(0px, calc(var(--omnigent-viewport-height, 100dvh) - ${top} - max(${bounds.collisionPadding.bottom}px, var(--omnigent-inset-bottom, 0px))))`,
        } as CSSProperties
      }
    >
      <div className="notification-toast-scroll">
        {!centerOpen && required.map((entry) => <NotificationCard key={entry.id} entry={entry} />)}
        {!centerOpen && ordinary.map((entry) => <NotificationCard key={entry.id} entry={entry} />)}
      </div>
    </aside>
  );
}
