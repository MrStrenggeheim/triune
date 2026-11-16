import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";
// ⌘K (Ctrl+K on Win/Linux) toggles the global command palette. Sibling to the
// session-switch (⌘[ / ⌘]) and sidebar-toggle (⌘⌥[ / ⌘⌥]) hotkeys; like them
// it's bound ONCE at the app shell, where the palette's open-state lives.
//
// Why ⌘K: it's the de-facto command-palette key across developer tools, and
// issue #1059 / PR #1064 deliberately reserved it for this (PR #1064 took ⌘⇧F
// for sidebar search precisely to leave ⌘K free). The browser binds Ctrl+K to
// the address bar, so we preventDefault to claim it.
//
// Platform-aware: only ⌘K fires on macOS and only Ctrl+K on Win/Linux.
// Focused surfaces can still own the chord, but only the variant they actually
// consume — see `focusOwnsHotkey`.

import { isMacPlatform } from "@/lib/hotkeys";

/** Monaco: ⌘K and Ctrl+K are both chord prefixes, on every platform. */
const CHORD_PREFIX_SURFACE = ".monaco-editor";

/** xterm: forwards the CONTROL variant to the PTY as ^K (kill-to-end-of-line). */
const PTY_SURFACE = ".xterm";

/** True when the event is the command-palette chord: the platform command
 *  modifier + K, no Alt/Shift. */
export function isCommandPaletteHotkey(
  e: globalThis.KeyboardEvent,
  isMac = isMacPlatform(),
): boolean {
  return matchesShortcutCommand(e, "command-palette", { ...shortcutEnvironment(), isMac });
}

/**
 * Does the focused surface consume THIS chord?
 *
 * Monaco takes both variants. A terminal only takes Ctrl+K: xterm turns it into
 * VT ^K, but drops Cmd chords entirely on macOS (Cmd+A is its lone exception),
 * so yielding ⌘K to a focused terminal leaves it dead — nothing opens and the
 * PTY never sees it. The palette claims that variant instead.
 */

/**
 * Bind ⌘/Ctrl+K to toggle the command palette. Bind ONCE.
 *
 * @param onToggle Flip the palette open/closed.
 * @param enabled  Pass `false` to disable the hotkey (e.g. embedded in a real
 *   host page, where ⌘K belongs to the host). Defaults to enabled.
 */
export function useCommandPaletteHotkey(
  onToggle: () => void,
  enabled = true,
  isMac = isMacPlatform(),
  onSessionSearch?: () => void,
): void {
  const available = () => {
    const element = document.activeElement;
    return !(
      element instanceof Element &&
      (element.closest(CHORD_PREFIX_SURFACE) || (!isMac && element.closest(PTY_SURFACE)))
    );
  };
  useShortcutHandlers(
    {
      "command-palette": () => {
        if (!available()) return false;
        onToggle();
        return true;
      },
      ...(onSessionSearch
        ? {
            "session-search": () => {
              if (!available()) return false;
              onSessionSearch();
              return true;
            },
          }
        : {}),
    },
    enabled,
    isMac,
  );
}
