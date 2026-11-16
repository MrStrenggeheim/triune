import { useSyncExternalStore } from "react";
import { isMacPlatform } from "./hotkeys";
import { getCurrentUserId, subscribeIdentity } from "./identity";
import { getOmnigentServerIdentity, getEmbedRoot } from "./host";
import { isElectronShell, isNativeShell } from "./nativeBridge";
import {
  bindingKeys,
  isZoomStroke,
  matchesStroke,
  COMMANDS,
  WHEN,
  compatibleWhen,
  defaultBindings,
  effectiveBindings,
  normalizeStroke,
  type Binding,
  type BindingEnvironment,
  type BindingId,
  type Overrides,
  type Stroke,
  type WhenId,
} from "./keybindingRegistry";

export const KEYBINDINGS_CHANGED = "omnigent:keybindings-changed";
export function shortcutEnvironment(): BindingEnvironment {
  return {
    isMac: isMacPlatform(),
    native: isNativeShell(),
    runtime: isElectronShell() ? "electron" : getEmbedRoot() ? "embedded" : "web",
  };
}
export function keybindingStorageKey(
  environment = shortcutEnvironment(),
  viewer = getCurrentUserId() ?? "anonymous",
  server = getOmnigentServerIdentity() || window.location.origin,
): string {
  const platform = environment.isMac
    ? "mac"
    : /Win/i.test(navigator.platform)
      ? "windows"
      : "linux";
  return `omnigent:keybindings:v1:${JSON.stringify([server, viewer, environment.runtime, environment.native ? "native" : "browser", platform])}`;
}
export function readKeybindingOverrides(
  key = keybindingStorageKey(),
  environment = shortcutEnvironment(),
): Overrides {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    if (
      saved?.version !== 1 ||
      !saved.overrides ||
      typeof saved.overrides !== "object" ||
      Array.isArray(saved.overrides)
    )
      return {};
    const result: Overrides = {};
    for (const [id, value] of Object.entries(saved.overrides)) {
      const command = id.slice(0, id.lastIndexOf(":"));
      if (!Object.hasOwn(COMMANDS, command) || id.length > 160) continue;
      if (value === null) {
        result[id as BindingId] = null;
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const stroke = item.stroke as Record<string, unknown> | undefined;
      if (
        !stroke ||
        !Array.isArray(stroke.modifiers) ||
        !stroke.modifiers.every((mod) => ["Ctrl", "Meta", "Alt", "Shift"].includes(mod)) ||
        !Object.hasOwn(WHEN, String(item.when))
      )
        continue;
      const match = stroke.match as Record<string, unknown> | undefined;
      if (
        !match ||
        Object.keys(match).length !== 1 ||
        !(
          (typeof match.key === "string" && match.key.length > 0 && match.key.length < 64) ||
          (typeof match.code === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(match.code))
        )
      )
        continue;
      const row: Binding = {
        id: id as BindingId,
        command: command as keyof typeof COMMANDS,
        when: item.when as WhenId,
        stroke: normalizeStroke(stroke as unknown as Stroke),
        source: "User",
      };
      if (!compatibleWhen(row, row.when, environment)) continue;
      result[row.id] = { stroke: row.stroke!, when: row.when };
    }
    return result;
  } catch (error) {
    console.warn("[shortcuts] Could not read saved bindings", error);
    return {};
  }
}
export function writeKeybindingOverrides(
  overrides: Overrides,
  key = keybindingStorageKey(),
): boolean {
  try {
    if (Object.keys(overrides).length)
      window.localStorage.setItem(key, JSON.stringify({ version: 1, overrides }));
    else window.localStorage.removeItem(key);
    window.dispatchEvent(new Event(KEYBINDINGS_CHANGED));
    return true;
  } catch (error) {
    console.warn("[shortcuts] Could not save bindings", error);
    return false;
  }
}
export function readEffectiveBindings(environment = shortcutEnvironment()): Binding[] {
  return effectiveBindings(
    environment,
    readKeybindingOverrides(keybindingStorageKey(environment), environment),
  );
}
export function shortcutKeys(
  command: keyof typeof COMMANDS,
  environment = shortcutEnvironment(),
): string[] {
  const row = readEffectiveBindings(environment).find(
    (item) => item.command === command && item.stroke,
  );
  return row ? bindingKeys(row.stroke, environment.isMac) : [];
}
function subscribe(listener: () => void) {
  const identity = subscribeIdentity(listener);
  window.addEventListener("storage", listener);
  window.addEventListener(KEYBINDINGS_CHANGED, listener);
  return () => {
    identity();
    window.removeEventListener("storage", listener);
    window.removeEventListener(KEYBINDINGS_CHANGED, listener);
  };
}
export function useEffectiveBindings(): Binding[] {
  const environment = shortcutEnvironment();
  const serialized = useSyncExternalStore(
    subscribe,
    () => JSON.stringify(readEffectiveBindings(environment)),
    () => JSON.stringify(defaultBindings(environment)),
  );
  return JSON.parse(serialized) as Binding[];
}

/** Shared matching for compatibility callers; execution still belongs to the dispatcher. */
export function matchesShortcutCommand(
  event: KeyboardEvent,
  command: keyof typeof COMMANDS,
  environment = shortcutEnvironment(),
): boolean {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.getModifierState?.("AltGraph") ||
    isZoomStroke(event)
  )
    return false;
  return readEffectiveBindings(environment).some(
    (row) => row.command === command && row.stroke && matchesStroke(event, row.stroke),
  );
}
