import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";
// Ctrl+Shift+L (every platform, including macOS) focuses the composer's chat
// input, so the user can start typing from anywhere in the session view without
// reaching for the mouse.
//
// Ctrl, not the Mac Cmd command-modifier, and Ctrl+Shift+<letter> for parity
// with its sibling Ctrl+Shift+M model-picker chord — that family is free on
// every platform. L is unbound in Chrome/Firefox/Electron (unlike Ctrl+Shift+
// I/J/C, which open devtools). Like its siblings it bails when focus sits in a
// surface that owns its own keys (xterm terminals, the Monaco editor).

/** Selector for surfaces that own their keystrokes (terminals, code editor). */

/** True when the event is the focus-composer chord: Ctrl + Shift + L, no Cmd/Alt.
 *  Ctrl on every platform (see file header). */
export function isFocusComposerHotkey(e: globalThis.KeyboardEvent): boolean {
  return matchesShortcutCommand(e, "focus-composer", shortcutEnvironment());
}

/** Does focus sit inside a surface that owns its keystrokes (xterm / Monaco)? */

/**
 * Bind Ctrl+Shift+L to focus the composer's chat input.
 *
 * @param onFocus Focus the composer textarea (callers no-op on mobile, where
 *   programmatic focus would summon the software keyboard).
 * @param enabled Pass `false` to leave the chord untouched (e.g. no composer on
 *   screen). Defaults on.
 */
export function useFocusComposerHotkey(onFocus: () => void, enabled = true): void {
  useShortcutHandlers({ "focus-composer": onFocus }, enabled);
}
