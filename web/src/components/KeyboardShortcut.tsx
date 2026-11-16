import type { ReactNode } from "react";

export { CompactKbd } from "@/components/ui/kbd";
import { CompactShortcutKeys as ShortcutKeyChips } from "@/components/ui/kbd";
import { bindingKeys, type CommandId } from "@/lib/keybindingRegistry";
import {
  readEffectiveBindings,
  shortcutEnvironment,
  shortcutKeys,
  useEffectiveBindings,
} from "@/lib/keybindingPreferences";
import { TooltipContent } from "@/components/ui/tooltip";
import { isMacPlatform } from "@/lib/hotkeys";
import { isNativeShell } from "@/lib/nativeBridge";
import { cn } from "@/lib/utils";

const NO_SHORTCUT_KEYS: readonly string[] = [];
const IS_MAC = isMacPlatform();

export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
// Literal Control on every platform (⌃ on Mac), for chords that use Ctrl rather
// than the platform command modifier — unlike MOD_KEY, which is ⌘ on Mac.
export const CTRL_KEY = IS_MAC ? "⌃" : "Ctrl";
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";
export const ENTER_KEY = "↵";
export const SHIFT_KEY = "⇧";
export const ARIA_MOD_KEY = IS_MAC ? "Meta" : "Control";
export const VIEW_MODE_TOGGLE_KEYS = [MOD_KEY, ALT_KEY, "\\"] as const;

/** Primary registry binding; the customized older shortcut remains an editable alias. */
export function newSessionShortcutKeys(native = isNativeShell()): string[] {
  return shortcutKeys("new-chat", { ...shortcutEnvironment(), native });
}
export function commandAriaShortcut(command: CommandId): string {
  const stroke = readEffectiveBindings().find(
    (row) => row.command === command && row.stroke,
  )?.stroke;
  if (!stroke) return "";
  const key =
    "key" in stroke.match
      ? stroke.match.key
      : stroke.match.code
          .replace(/^Key|^Digit/, "")
          .replace("BracketLeft", "[")
          .replace("BracketRight", "]")
          .replace("Backslash", "\\")
          .replace("Comma", ",");
  return [
    ...stroke.modifiers.map((modifier) => (modifier === "Ctrl" ? "Control" : modifier)),
    key,
  ].join("+");
}
export function newSessionAriaShortcut(_native = isNativeShell()): string {
  return commandAriaShortcut("new-chat");
}
export function useCommandShortcutKeys(command: CommandId): string[] {
  const rows = useEffectiveBindings();
  return bindingKeys(rows.find((row) => row.command === command && row.stroke)?.stroke ?? null);
}
export function CompactShortcutKeys({
  keys = NO_SHORTCUT_KEYS,
  command,
  className,
}: {
  keys?: readonly string[];
  command?: CommandId;
  className?: string;
}) {
  const rows = useEffectiveBindings();
  const effective = command
    ? bindingKeys(rows.find((row) => row.command === command && row.stroke)?.stroke ?? null)
    : keys;
  return <ShortcutKeyChips keys={effective} className={className} />;
}

export function composerSendShortcutKeys(submitWithModEnter: boolean): string[] {
  return submitWithModEnter ? [MOD_KEY, ENTER_KEY] : [ENTER_KEY];
}

export function composerSteerAllShortcutKeys(submitWithModEnter: boolean): string[] {
  return submitWithModEnter ? [MOD_KEY, SHIFT_KEY, ENTER_KEY] : [MOD_KEY, ENTER_KEY];
}

export function composerNewLineShortcutKeys(submitWithModEnter: boolean): string[] {
  return submitWithModEnter ? [ENTER_KEY] : [SHIFT_KEY, ENTER_KEY];
}

export function Kbd({
  children,
  variant = "default",
}: {
  children: ReactNode;
  variant?: "default" | "dark";
}) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-muted px-1.5 font-sans text-sm font-medium text-muted-foreground",
        variant === "dark" && "border-slate-600 bg-slate-700 text-slate-300",
      )}
    >
      {children}
    </kbd>
  );
}

export function KeyboardShortcutTooltipContent({
  label,
  keys = NO_SHORTCUT_KEYS,
  command,
}: {
  label: string;
  keys?: readonly string[];
  command?: CommandId;
}) {
  const rows = useEffectiveBindings();
  const effective = command
    ? bindingKeys(rows.find((row) => row.command === command && row.stroke)?.stroke ?? null)
    : keys;
  return (
    <TooltipContent side="top" shortcut={effective}>
      <span>{label}</span>
    </TooltipContent>
  );
}
