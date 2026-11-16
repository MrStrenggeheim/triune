import { matchesShortcutCommand, shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useShortcutHandlers } from "@/lib/shortcutDispatcher";

import { isMacPlatform } from "@/lib/hotkeys";
import { isNativeShell } from "@/lib/nativeBridge";
import { useNavigate } from "@/lib/routing";

/** Browser Cmd/Ctrl+Shift+O; preserve the native Cmd/Ctrl+Alt+N chord. */
export function isNewSessionHotkey(
  e: globalThis.KeyboardEvent,
  isMac = isMacPlatform(),
  native = isNativeShell(),
): boolean {
  return matchesShortcutCommand(e, "new-chat", { ...shortcutEnvironment(), isMac, native });
}

/** Navigate to the same new-session route used by the command palette. */
export function useNewSessionHotkey(enabled = true, isMac = isMacPlatform()): void {
  const navigate = useNavigate();
  useShortcutHandlers(
    {
      "new-chat": () => {
        navigate("/");
      },
    },
    enabled,
    isMac,
  );
}
