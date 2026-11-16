import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";

import { isMacPlatform } from "@/lib/hotkeys";
import { useNavigate } from "@/lib/routing";

/** True for Cmd+Alt+, on Apple platforms or Ctrl+Alt+, elsewhere. */
export function isSettingsHotkey(
  event: globalThis.KeyboardEvent,
  isMac = isMacPlatform(),
): boolean {
  return matchesShortcutCommand(event, "go-settings", { ...shortcutEnvironment(), isMac });
}

/** Navigate to Settings from anywhere in the app. */
export function useSettingsHotkey(enabled = true, isMac = isMacPlatform()): void {
  const navigate = useNavigate();
  useShortcutHandlers(
    {
      "go-settings": () => {
        navigate("/settings");
      },
    },
    enabled,
    isMac,
  );
}
