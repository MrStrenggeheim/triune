import { registerShortcutHandlers } from "@/lib/shortcutDispatcher";
import { shortcutEnvironment } from "@/lib/keybindingPreferences";
import { useEffect, useRef } from "react";
import { isMacPlatform } from "@/lib/hotkeys";
import {
  getFindContext,
  recordFindInteraction,
  registerFindContext,
  REQUEST_FILE_FIND_EVENT,
} from "@/lib/findContext";

interface ContextualFindOptions {
  onChatFind: (scope: "current" | "all") => void;
  onExplorerFind: () => void;
  enabled?: boolean;
  isMac?: boolean;
}

/** Route Find by the last interacted region while retaining specialized owners. */
export function useContextualFindHotkey({
  onChatFind,
  onExplorerFind,
  enabled = true,
  isMac = isMacPlatform(),
}: ContextualFindOptions): void {
  const callbacks = useRef({ onChatFind, onExplorerFind });
  callbacks.current = { onChatFind, onExplorerFind };
  useEffect(() => {
    if (!enabled) return;
    const unregister = registerFindContext();
    const interaction = (event: Event) => recordFindInteraction(event.target);
    const keydown = (event: KeyboardEvent) => {
      const context = getFindContext();
      if (!context || context.region === "native") return false;
      if (context.region === "file") {
        const request = new CustomEvent(REQUEST_FILE_FIND_EVENT, {
          detail: { target: context.target },
          cancelable: true,
        });
        window.dispatchEvent(request);
        // Keep browser/specialized find when this preview has no app find surface.
        if (!request.defaultPrevented) return false;
      } else if (context.region === "explorer") callbacks.current.onExplorerFind();
      else callbacks.current.onChatFind(context.region === "sidebar" ? "all" : "current");
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    for (const name of ["pointerdown", "mousedown", "focusin"])
      window.addEventListener(name, interaction, true);
    const removeShortcut = registerShortcutHandlers(
      { find: keydown },
      { ...shortcutEnvironment(), isMac },
    );
    return () => {
      unregister();
      for (const name of ["pointerdown", "mousedown", "focusin"])
        window.removeEventListener(name, interaction, true);
      removeShortcut();
    };
  }, [enabled, isMac]);
}
