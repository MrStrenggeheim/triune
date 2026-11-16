import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";

import { isMacPlatform } from "@/lib/hotkeys";

type ViewMode = "chat" | "terminal";

interface ViewModeToggleHotkeyOptions {
  enabled: boolean;
  view: ViewMode;
  setView: (view: ViewMode) => void;
}

/** True for Cmd+Alt+\ on Apple platforms or Ctrl+Alt+\ elsewhere. */
export function isViewModeToggleHotkey(
  event: globalThis.KeyboardEvent,
  isMac = isMacPlatform(),
): boolean {
  return matchesShortcutCommand(event, "toggle-view-mode", { ...shortcutEnvironment(), isMac });
}

export function useViewModeToggleHotkey(
  options: ViewModeToggleHotkeyOptions,
  isMac = isMacPlatform(),
): void {
  useShortcutHandlers(
    { "toggle-view-mode": () => options.setView(options.view === "chat" ? "terminal" : "chat") },
    options.enabled,
    isMac,
  );
}
