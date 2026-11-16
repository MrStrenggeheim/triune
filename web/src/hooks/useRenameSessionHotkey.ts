import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";

import { isMacPlatform } from "@/lib/hotkeys";

/** Cmd/Ctrl+Alt+R; match the physical key because Option changes its character. */
export function isRenameSessionHotkey(
  event: globalThis.KeyboardEvent,
  isMac = isMacPlatform(),
): boolean {
  return matchesShortcutCommand(event, "rename-session", { ...shortcutEnvironment(), isMac });
}

/** Bind alongside the owner-only title editor so unavailable sessions keep their keys. */
export function useRenameSessionHotkey(
  onRename: () => void,
  enabled = true,
  isMac = isMacPlatform(),
): void {
  useShortcutHandlers({ "rename-session": onRename }, enabled, isMac);
}
