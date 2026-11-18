// Modified for Triune.
import type { ComponentProps, ReactNode } from "react";
import {
  ArrowLeftIcon,
  PanelLeftOpenIcon,
  PanelRightOpenIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";

import { ALT_KEY, ARIA_MOD_KEY, MOD_KEY } from "@/components/KeyboardShortcut";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Link } from "@/lib/routing";
import { cn } from "@/lib/utils";

import { SIDEBAR_ACTIVE_HIGHLIGHT, SIDEBAR_HOVER_HIGHLIGHT, SIDEBAR_ROW } from "./sidebarStyles";

const SIDEBAR_TOGGLE_KEYS = [MOD_KEY, ALT_KEY, "["] as const;
const SEARCH_KEYS = [MOD_KEY, "K"] as const;
const SETTINGS_KEYS = [MOD_KEY, ALT_KEY, ","] as const;

/** Shared actions; only the persistent macOS title-bar copy includes a toggle. */
export function SidebarHeaderActions({
  compact = false,
  showToggle = true,
  showSearch = true,
  expanded,
  onToggle,
  onOpenSearch,
  onSettingsClick,
  onTogglePointerEnter,
  onTogglePointerDown,
  onTogglePointerLeave,
}: {
  compact?: boolean;
  /** Only the persistent title-bar copy needs a navigation toggle. */
  showToggle?: boolean;
  /** The application bar retains search while the sidebar entry is paused. */
  showSearch?: boolean;
  /**
   * Whether the sidebar currently reads as open — `open || peek`. Drives the
   * toggle only: expanded collapses, collapsed (or peeking) opens.
   */
  expanded: boolean;
  /** Collapse an expanded sidebar, or open a collapsed/peeking one. */
  onToggle: () => void;
  /** Open the command palette (search). Optional so the cluster can render standalone. */
  onOpenSearch?: () => void;
  /**
   * Extra handler for the Settings link. The in-sidebar copy passes nothing (on
   * mobile, entering Settings keeps the drawer open and swaps it to the section
   * list); navigation itself is the Link's job.
   */
  onSettingsClick?: () => void;
  /**
   * Dwell-to-peek hooks for the toggle. On the macOS shell this cluster replaces
   * ChatHeader's collapsed-state button, which is where peek used to be armed,
   * so the behaviour has to ride along with it or dwell-to-peek disappears.
   */
  onTogglePointerEnter?: () => void;
  onTogglePointerDown?: () => void;
  onTogglePointerLeave?: () => void;
}) {
  return (
    <div className="flex items-center gap-1" data-testid="sidebar-header-actions">
      {showSearch && <SidebarSearchButton onOpenSearch={onOpenSearch} />}
      {!compact && (
        <SidebarSettingsButton onSettingsClick={onSettingsClick} className="max-md:hidden" />
      )}
      {showToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={expanded ? "Close sidebar" : "Open sidebar"}
              aria-keyshortcuts={`${ARIA_MOD_KEY}+Alt+[`}
              onClick={onToggle}
              onPointerEnter={onTogglePointerEnter}
              onPointerDown={onTogglePointerDown}
              onPointerLeave={onTogglePointerLeave}
              // Mobile drops the toggle entirely: there the sidebar is a drawer
              // that leaves a strip of the chat visible, and tapping that strip
              // is how you get back — a collapse icon would be a second, worse
              // way to do the same thing.
              className="size-6 text-muted-foreground hover:text-foreground max-md:hidden"
            >
              {/* panel-right-open reads as "push the panel away" while the sidebar
            is open; panel-left-open as "bring it back" once it is collapsed or
            merely peeking. */}
              {expanded ? (
                <PanelRightOpenIcon className="size-4" />
              ) : (
                <PanelLeftOpenIcon className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" shortcut={SIDEBAR_TOGGLE_KEYS}>
            <span>{expanded ? "Collapse sidebar" : "Open sidebar"}</span>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/** Shared sizing for the mobile icon-only Search and Settings actions. */
const SIDEBAR_FLOAT_BUTTON =
  "size-6 text-muted-foreground hover:text-foreground max-md:size-11 max-md:text-foreground";

const SIDEBAR_FLOAT_ICON = "size-4 max-md:size-[22px]";

/**
 * Search (command palette) icon button.
 *
 * Split out of the cluster because the mobile sidebar places it on its own —
 * floating at the top of the drawer, away from Settings, which floats at the
 * bottom.
 *
 * @param onOpenSearch - Opens the command palette. Optional so the button can
 *   render standalone (e.g. in tests).
 * @param className - Extra classes, e.g. the mobile float's positioning.
 */
export function SidebarSearchButton({
  onOpenSearch,
  className,
}: {
  onOpenSearch?: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Search"
          aria-keyshortcuts={`${ARIA_MOD_KEY}+K`}
          onClick={() => onOpenSearch?.()}
          className={cn(SIDEBAR_FLOAT_BUTTON, className)}
          data-testid="sidebar-search-button"
        >
          <SearchIcon className={SIDEBAR_FLOAT_ICON} />
        </Button>
      </TooltipTrigger>
      {/* Bottom placement keeps the tooltip clear of the macOS Electron
      shell's traffic lights at the window's top edge. */}
      <TooltipContent side="bottom" shortcut={SEARCH_KEYS}>
        <span>Search</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Settings icon button — a `Link` to `/settings`.
 *
 * @param onSettingsClick - Extra click handler; navigation itself is the
 *   Link's job.
 * @param className - Extra classes, e.g. the mobile float's positioning.
 * @param testId - `data-testid` on the link.
 */
export function SidebarSettingsButton({
  onSettingsClick,
  className,
  testId = "settings-button",
}: {
  onSettingsClick?: () => void;
  className?: string;
  /** Distinguishes the header-row copy from the mobile floating copy. */
  testId?: string;
}) {
  return (
    <Tooltip delayDuration={750}>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="ghost"
          size="icon-xs"
          aria-label="Settings"
          aria-keyshortcuts={`${ARIA_MOD_KEY}+Alt+,`}
          className={cn(SIDEBAR_FLOAT_BUTTON, "rounded-[8px] bg-transparent", className)}
        >
          <Link to="/settings" onClick={onSettingsClick} data-testid={testId}>
            <SettingsIcon className={SIDEBAR_FLOAT_ICON} />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" shortcut={SETTINGS_KEYS}>
        <span>Settings</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function SidebarActionGroup({
  children,
  testId,
  footer = false,
  className,
}: {
  children: ReactNode;
  testId: string;
  footer?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("flex shrink-0 flex-col gap-px px-2", footer ? "pb-2" : "pt-2", className)}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function SidebarNavAction({
  active,
  className,
  ...props
}: ComponentProps<typeof Button> & { active?: boolean }) {
  return (
    <Button
      {...props}
      asChild
      variant="ghost"
      className={cn(
        SIDEBAR_ROW,
        "density-row w-full justify-start border-0 font-normal",
        SIDEBAR_HOVER_HIGHLIGHT,
        active && SIDEBAR_ACTIVE_HIGHLIGHT,
        className,
      )}
    />
  );
}

export function SidebarSettingsFooter({ returnPath }: { returnPath?: string }) {
  return (
    <SidebarActionGroup
      footer
      testId="sidebar-settings-footer"
      className={returnPath !== undefined ? "max-md:mr-14" : undefined}
    >
      <SidebarNavAction>
        {returnPath !== undefined ? (
          <Link to={returnPath} componentId="settings.back_to_omnigent">
            <ArrowLeftIcon className="ui-icon text-muted-foreground" />
            Back
          </Link>
        ) : (
          <Link
            to="/settings"
            componentId="sidebar.settings"
            aria-keyshortcuts={`${ARIA_MOD_KEY}+Alt+,`}
            data-testid="settings-button"
          >
            <SettingsIcon className="ui-icon text-muted-foreground" />
            Settings
          </Link>
        )}
      </SidebarNavAction>
    </SidebarActionGroup>
  );
}
