import { useShortcutHandlers } from "@/lib/shortcutDispatcher";
// ⌘⌥[ / ⌘⌥] (Ctrl+Alt+[ / Ctrl+Alt+] on Win/Linux) toggle the left
// (Conversations) and right (Workspace) sidebars. Siblings to the session-switch
// (⌘[ / ⌘]) and approve (⌘↵) hotkeys; like them they fire even inside a focused
// text field, so a panel can be collapsed mid-compose. Platform-aware: only the
// ⌘ chord fires on macOS and only the Ctrl chord on Win/Linux.
//
// Why this chord: the bare ⌘[ / ⌘] are the browser's Back/Forward gestures, and
// single ⌘+punctuation combos (e.g. ⌘\) get swallowed by global hotkey utilities
// (Raycast/Rectangle/…) before the page ever sees them. Adding ⌥ dodges both —
// it's not a browser gesture and is essentially never grabbed system-wide — and
// it shares the ⌘⌥ chord with ChatPage's message-nav hotkey. Bind ONCE at the
// app shell, where the sidebar open-state lives.

import { isMacPlatform } from "@/lib/hotkeys";

export interface SidebarToggleHandlers {
  /** Flip the left (Conversations) sidebar. Bound to ⌘/Ctrl + ⌥/Alt + [. */
  onToggleLeft: () => void;
  /** Flip the right (Workspace) sidebar. Bound to ⌘/Ctrl + ⌥/Alt + ]. */
  onToggleRight: () => void;
  /** Direct I toggle; the alternate bracket chord may focus before closing. */
  onToggleRightDirect?: () => void;
}

export function useSidebarToggleHotkeys(
  handlers: SidebarToggleHandlers,
  isMac = isMacPlatform(),
): void {
  useShortcutHandlers(
    {
      "toggle-left-sidebar": handlers.onToggleLeft,
      "toggle-right-sidebar": handlers.onToggleRight,
      "toggle-right-sidebar-direct": handlers.onToggleRightDirect ?? handlers.onToggleRight,
    },
    true,
    isMac,
  );
}
