import { isMacPlatform } from "@/lib/hotkeys";
import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";
// ⌘⌥T (Ctrl+Alt+T on Win/Linux) opens a new shell in the workspace rail,
// launching the remembered default type — the keyboard path for the tab-strip
// "+" menu, whose row launches on click (mouse-only otherwise). Sibling to the
// other app-shell hotkeys (⌘K palette, ⌘⌥[ / ⌘⌥] sidebars); like them it's
// bound ONCE at the app shell, where the shell-launch wiring lives.
//
// Why ⌘⌥T: it joins the app's ⌘⌥ family (sidebar toggles, voice) with no
// browser/OS clash — unlike ⌘` (macOS window cycling) or ⌘⇧T (browser reopen-
// tab). "T" for terminal.

/** Editor/terminal surfaces that own their own keystrokes; the chord defers. */

/** True for Cmd+Alt+T on Apple platforms or Ctrl+Alt+T elsewhere. */
export function isNewShellHotkey(e: globalThis.KeyboardEvent, isMac = isMacPlatform()): boolean {
  return matchesShortcutCommand(e, "new-terminal", { ...shortcutEnvironment(), isMac });
}

/**
 * Bind ⌘/Ctrl+Alt+T to open a new shell. Bind ONCE at the app shell.
 *
 * The chord defers to a focused Monaco editor or xterm terminal — those
 * surfaces own their keystrokes, and stealing the chord mid-edit would surprise
 * the user. It fires only when ``enabled`` (the caller gates on the session
 * declaring shell access and being reachable).
 *
 * @param onLaunch Open the default shell (no-op if the caller can't right now).
 * @param enabled  Pass ``false`` to disable (no session, no shell access, or an
 *   offline session the browser can't reconnect). Defaults to enabled.
 */
export function useNewShellHotkey(
  onLaunch: () => void,
  enabled = true,
  isMac = isMacPlatform(),
): void {
  useShortcutHandlers({ "new-terminal": onLaunch }, enabled, isMac);
}
export function useManualTerminalHotkey(
  onOpen: () => void,
  enabled = true,
  isMac = isMacPlatform(),
): void {
  useShortcutHandlers({ "open-terminal": onOpen }, enabled, isMac);
}
