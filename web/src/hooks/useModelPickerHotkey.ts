import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";
// Ctrl+Shift+M (every platform, including macOS) opens the composer's model
// picker: the keyboard equivalent of typing bare "/model", reachable without
// leaving the keyboard.
//
// Ctrl, not the Mac Cmd command-modifier: every Cmd form of M collides on
// macOS (⌘M minimizes the window, ⌥⌘M minimizes all, ⌘⇧M is Chrome's profile
// switcher). Ctrl+Shift+M is free on macOS and was already the Win/Linux chord,
// so one binding works everywhere. Like its sibling hotkeys it bails when focus
// sits in a surface that owns its own keys (xterm terminals, the Monaco editor).

/** Selector for surfaces that own their keystrokes (terminals, code editor). */

/** True when the event is the model-picker chord: Ctrl + Shift + M, no Cmd/Alt.
 *  Ctrl on every platform (see file header). */
export function isModelPickerHotkey(e: globalThis.KeyboardEvent): boolean {
  return matchesShortcutCommand(e, "model-picker", shortcutEnvironment());
}

/** Does focus sit inside a surface that owns its keystrokes (xterm / Monaco)? */

/**
 * Bind Ctrl+Shift+M to open the composer's model picker.
 *
 * @param onOpen  Open the picker (pass the same nonce bump the "/model" submit
 *   path uses).
 * @param enabled Mirror the gear's open path (a model picker exists and the
 *   gear is not disabled: not read-only, unreachable, or busy); pass `false` to
 *   leave the chord untouched when there's nothing to open. Defaults on.
 */
export function useModelPickerHotkey(onOpen: () => void, enabled = true): void {
  useShortcutHandlers({ "model-picker": onOpen }, enabled);
}
