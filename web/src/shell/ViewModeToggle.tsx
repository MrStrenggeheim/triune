import { Loader2Icon, MessagesSquareIcon, TerminalIcon } from "lucide-react";
import { commandAriaShortcut, useCommandShortcutKeys } from "@/components/KeyboardShortcut";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { useViewModeToggleHotkey } from "@/hooks/useViewModeToggleHotkey";
import { useTerminalFirst } from "./TerminalFirstContext";

const ignoreViewChange = () => {};

/**
 * Header Chat/Terminal switcher for terminal-first sessions. Two icon
 * segments in a shared track show both destinations at once, so the
 * active view is readable at a glance and switching is one click — no
 * menu to open. Status lives in the sidebar; this is purely a view
 * toggle.
 *
 * Self-gates to null when there's nothing to toggle:
 *   - non-terminal-first sessions,
 *   - a rail-opened shell owning the main view (isShellView) — its own
 *     close affordance is the way back to chat.
 *
 * On a desktop-width viewport it renders in the header on every shell — the
 * native iOS bottom pill is retired (AppShell pushes it hidden at boot), so the
 * header is the one placement. On a mobile-width viewport the segmented track
 * is dropped and the switch folds into the header kebab instead (see
 * {@link ViewModeMenuItems}), so the narrow header pill isn't split between a
 * view switch and the "…" menu.
 */
export function ViewModeToggle({ hotkeyEnabled = true, alwaysVisible = false } = {}) {
  const viewModeKeys = useCommandShortcutKeys("toggle-view-mode");
  const ctx = useTerminalFirst();
  const isMobile = useIsMobileViewport();
  useViewModeToggleHotkey({
    enabled: Boolean(hotkeyEnabled && ctx?.isTerminalFirst && !ctx.isShellView),
    view: ctx?.view ?? "chat",
    setView: ctx?.setView ?? ignoreViewChange,
  });
  if (!ctx || !ctx.isTerminalFirst || ctx.isShellView) return null;
  // Mobile folds the switch into the header kebab (ViewModeMenuItems).
  if (isMobile && !alwaysVisible) return null;

  const { view, setView, terminalStartingUp } = ctx;
  const terminalLabel = terminalStartingUp ? "Terminal is starting up…" : "Terminal view";

  return (
    <SegmentedControl
      aria-label="Switch between chat and terminal"
      data-testid="view-mode-toggle"
      // Two 36×24 segments separated by 2px make a flush 74×24 track.
      // Desktop-only — mobile folds the switch into the header kebab.
      className="w-[74px]"
    >
      <SegmentedControlItem
        label="Chat view"
        active={view === "chat"}
        onClick={() => setView("chat")}
        data-testid="view-mode-chat"
        iconOnly
        aria-keyshortcuts={commandAriaShortcut("toggle-view-mode")}
        shortcut={viewModeKeys}
        componentId="chat.header.view_chat"
      >
        <MessagesSquareIcon className="size-4" />
      </SegmentedControlItem>
      <SegmentedControlItem
        label={terminalLabel}
        active={view === "terminal"}
        onClick={() => setView("terminal")}
        data-testid="view-mode-terminal"
        iconOnly
        aria-keyshortcuts={commandAriaShortcut("toggle-view-mode")}
        shortcut={viewModeKeys}
        componentId="chat.header.view_terminal"
      >
        {terminalStartingUp ? (
          <Loader2Icon className="size-4 animate-spin" aria-hidden />
        ) : (
          <TerminalIcon className="size-4" />
        )}
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

/**
 * Chat/Terminal switch as dropdown-menu items — the mobile counterpart of the
 * {@link ViewModeToggle} segmented track, folded into the header kebab so the
 * narrow header pill carries one trigger instead of a switch beside the "…"
 * menu. Self-gates to null on the same conditions as the toggle (non
 * terminal-first sessions, and a shell owning the main view). The active view
 * carries a trailing check; a trailing separator sets the switch off from the
 * menu items that follow.
 */
export function ViewModeMenuItems() {
  const ctx = useTerminalFirst();
  if (!ctx || !ctx.isTerminalFirst || ctx.isShellView) return null;

  const { view, setView, terminalStartingUp } = ctx;
  const terminalLabel = terminalStartingUp ? "Terminal (starting up…)" : "Terminal";

  return (
    <>
      <DropdownMenuRadioGroup
        value={view}
        onValueChange={(value) => {
          if (value === "chat" || value === "terminal") setView(value);
        }}
      >
        <DropdownMenuRadioItem
          className="gap-2.5 px-2.5 py-2 text-ui"
          value="chat"
          data-testid="view-mode-menu-chat"
        >
          <MessagesSquareIcon className="size-4" />
          Chat
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          className="gap-2.5 px-2.5 py-2 text-ui"
          value="terminal"
          data-testid="view-mode-menu-terminal"
        >
          {terminalStartingUp ? (
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
          ) : (
            <TerminalIcon className="size-4" />
          )}
          {terminalLabel}
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
    </>
  );
}
