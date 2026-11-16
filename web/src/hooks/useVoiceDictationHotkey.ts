import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";
// ⌘⌥V (Ctrl+Alt+V on Win/Linux) toggles voice dictation — the same action as
// clicking the composer mic button, reachable from anywhere in the app so you
// can start/stop talking without leaving the keyboard (WhisperFlow-style).
//
// Why this chord: single-modifier letter combos collide with OS/browser
// defaults (⌘M minimizes the window on macOS; most ⌘⇧-letter combos are browser
// shortcuts). Adding ⌥ dodges both — it shares the browser-safe ⌘⌥ chord used by
// the sidebar-toggle (⌘⌥[ / ⌘⌥]) and pinned-session (⌘⌥1–0) hotkeys. Like its
// siblings it bails when focus sits in a surface that owns its own keys (xterm
// terminals, the Monaco editor).

import { isMacPlatform } from "@/lib/hotkeys";

/** Selector for surfaces that own their keystrokes (terminals, code editor). */

/** True when the event is the voice-dictation chord: the platform command
 *  modifier + Alt + V, no Shift. */
export function isVoiceDictationHotkey(
  e: globalThis.KeyboardEvent,
  isMac = isMacPlatform(),
): boolean {
  return matchesShortcutCommand(e, "voice-dictation", { ...shortcutEnvironment(), isMac });
}

/** Does focus sit inside a surface that owns its keystrokes (xterm / Monaco)? */

/**
 * Bind ⌘/Ctrl+⌥/Alt+V to toggle voice dictation.
 *
 * @param onToggle Start or stop the recognizer (the mic button's toggle).
 * @param enabled  Pass `false` to skip binding (e.g. the secondary composer in
 *   the New Chat dialog, so two mics don't fight for the device). Defaults on.
 */
export function useVoiceDictationHotkey(
  onToggle: () => void,
  enabled = true,
  isMac = isMacPlatform(),
): void {
  useShortcutHandlers({ "voice-dictation": onToggle }, enabled, isMac);
}
