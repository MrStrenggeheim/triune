import { useShortcutHandlers } from "./shortcutDispatcher";
import type { CommandId } from "./keybindingRegistry";

/** Sidebar owns ordering/ACL; this adapter only registers its existing navigation actions. */
export function useSidebarShortcutCommands({
  orderedIds,
  orderedPinnedIds,
  activeId,
  navigate,
  enabled = true,
}: {
  orderedIds: readonly string[];
  orderedPinnedIds: readonly string[];
  activeId?: string;
  navigate: (path: string) => void;
  enabled?: boolean;
}) {
  const step = (direction: -1 | 1) => {
    if (!orderedIds.length) return false;
    const index = activeId ? orderedIds.indexOf(activeId) : -1;
    const next =
      index < 0
        ? direction > 0
          ? 0
          : orderedIds.length - 1
        : (index + direction + orderedIds.length) % orderedIds.length;
    if (orderedIds[next] !== activeId) navigate(`/c/${orderedIds[next]}`);
    return true;
  };
  useShortcutHandlers(
    {
      "previous-session": () => step(-1),
      "next-session": () => step(1),
      ...Object.fromEntries(
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((digit, index) => [
          `pinned-session-${digit}` as CommandId,
          () => {
            const id = orderedPinnedIds[index];
            if (!id) return false;
            if (id !== activeId) navigate(`/c/${id}`);
            return true;
          },
        ]),
      ),
    },
    enabled,
  );
}
