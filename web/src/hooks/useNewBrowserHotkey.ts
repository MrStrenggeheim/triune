import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";

import { isMacPlatform } from "@/lib/hotkeys";

/** True for Cmd+Alt+B on Apple platforms or Ctrl+Alt+B elsewhere. */
export function isNewBrowserHotkey(
  event: globalThis.KeyboardEvent,
  isMac = isMacPlatform(),
): boolean {
  return matchesShortcutCommand(event, "new-browser", { ...shortcutEnvironment(), isMac });
}

/** Bind the new-browser-tab shortcut while the workspace supports Browser. */
export function useNewBrowserHotkey(
  onOpen: () => void,
  enabled = true,
  isMac = isMacPlatform(),
): void {
  useShortcutHandlers({ "new-browser": onOpen }, enabled, isMac);
}
