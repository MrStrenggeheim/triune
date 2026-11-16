import { useEffect, useRef, useSyncExternalStore } from "react";
import { isImeCompositionKeyEvent } from "./ime";
import { getEmbedRoot } from "./host";
import { isMacPlatform } from "./hotkeys";
import {
  WHEN,
  matchesStroke,
  isZoomStroke,
  whenMatches,
  type BindingEnvironment,
  type CommandId,
  type ShortcutContext,
  type Surface,
} from "./keybindingRegistry";
import {
  KEYBINDINGS_CHANGED,
  readEffectiveBindings,
  shortcutEnvironment,
} from "./keybindingPreferences";
import {
  onNativeShortcut,
  publishNativeShortcuts,
  supportsNativeShortcuts,
  type NativeShortcutRequest,
} from "./nativeBridge";

export type ShortcutHandler = (event: KeyboardEvent, context: ShortcutContext) => void | boolean;
interface Registration {
  handlers: Partial<Record<CommandId, ShortcutHandler>>;
  environment: BindingEnvironment;
  priority: number;
}
const registrations = new Set<Registration>();
const commandListeners = new Set<() => void>();
function notifyCommands() {
  for (const listener of commandListeners) listener();
}
export function useRegisteredShortcutCommands(): readonly CommandId[] {
  const ids = useSyncExternalStore(
    (listener) => {
      commandListeners.add(listener);
      return () => {
        commandListeners.delete(listener);
      };
    },
    () =>
      [...new Set([...registrations].flatMap((owner) => Object.keys(owner.handlers)))]
        .sort()
        .join(","),
    () => "",
  );
  return ids ? (ids.split(",") as CommandId[]) : [];
}
let detach: (() => void) | undefined;
let nativeGeneration = "";
let paused = 0;
export function pauseShortcutDispatch(): () => void {
  paused++;
  refreshNative();
  return () => {
    paused = Math.max(0, paused - 1);
    refreshNative();
  };
}
export function shortcutSurface(): Surface {
  const focused = document.activeElement;
  if (
    document.querySelector('[cmdk-root][data-state="open"], [cmdk-dialog]') ||
    focused?.closest("[cmdk-input]")
  )
    return "palette";
  if (
    focused?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') ||
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
    )
  )
    return "modal";
  if (focused?.closest(".monaco-editor")) return "editor";
  if (focused?.closest(".xterm")) return "terminal";
  if (focused?.closest('textarea, input, [contenteditable="true"]')) return "composer";
  return "workbench";
}
function context(environment: BindingEnvironment, nativeSurface?: Surface): ShortcutContext {
  const focused = document.activeElement;
  const view = focused?.closest<HTMLElement>("[data-workbench-view]");
  const pane = focused?.closest<HTMLElement>("[data-pane-id]");
  const surface = shortcutSurface();
  return {
    active: true,
    runtime: environment.runtime,
    surface: surface === "modal" || surface === "palette" ? surface : (nativeSurface ?? surface),
    viewId: view?.dataset.workbenchView,
    paneId: pane?.dataset.paneId,
  };
}
function eligible(
  command: CommandId,
  event: KeyboardEvent,
  current: ShortcutContext,
  environment: BindingEnvironment,
): boolean {
  if (command === "command-palette" && current.surface === "terminal" && !environment.isMac)
    return false;
  if (environment.runtime === "embedded") {
    const root = getEmbedRoot();
    if (!root || !event.composedPath().includes(root)) return false;
  }
  return true;
}
export function dispatchShortcut(event: KeyboardEvent, nativeSurface?: Surface): boolean {
  if (
    paused ||
    event.defaultPrevented ||
    event.repeat ||
    isImeCompositionKeyEvent({ nativeEvent: event }) ||
    ["Dead", "Process", "Unidentified"].includes(event.key) ||
    event.getModifierState?.("AltGraph") ||
    isZoomStroke(event)
  )
    return false;
  const candidates = [...registrations]
    .flatMap((owner) => {
      const current = context(owner.environment, nativeSurface);
      return readEffectiveBindings(owner.environment)
        .filter(
          (row) =>
            row.stroke &&
            owner.handlers[row.command] &&
            matchesStroke(event, row.stroke) &&
            whenMatches(row.when, current.surface),
        )
        .map((row) => ({ owner, row, current }));
    })
    .sort(
      (left, right) =>
        Number(right.row.source === "User") - Number(left.row.source === "User") ||
        WHEN[left.row.when].surfaces.length - WHEN[right.row.when].surfaces.length ||
        left.row.id.localeCompare(right.row.id) ||
        right.owner.priority - left.owner.priority,
    );
  const seen = new Set<CommandId>();
  for (const { owner, row, current } of candidates) {
    if (seen.has(row.command)) continue;
    seen.add(row.command);
    if (!eligible(row.command, event, current, owner.environment)) continue;
    if (owner.handlers[row.command]!(event, current) === false) continue;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (row.command === "previous-view" || row.command === "next-view")
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(
            '.dock-pane[data-focused="true"] [role="tab"][aria-selected="true"]',
          )
          ?.focus(),
      );
    return true;
  }
  return false;
}
function dispatchNative(request: NativeShortcutRequest) {
  if (request.version !== 1 || request.generation !== nativeGeneration || paused) return;
  if (request.stroke) {
    const event = new KeyboardEvent("keydown", {
      ...request.stroke,
      bubbles: true,
      cancelable: true,
    });
    dispatchShortcut(event, request.surface);
    return;
  }
  // Menu clicks use the same live action owner, including its close guard.
  for (const owner of [...registrations].sort((a, b) => b.priority - a.priority)) {
    const handler = owner.handlers[request.command as CommandId];
    const current = context(owner.environment);
    if (!handler || current.surface === "modal" || current.surface === "palette") continue;
    if (handler(new KeyboardEvent("keydown"), current) !== false) return;
  }
}
function refreshNative() {
  if (!supportsNativeShortcuts()) return;
  const owners = [...registrations].sort((a, b) => b.priority - a.priority);
  const environment = owners[0]?.environment ?? shortcutEnvironment();
  nativeGeneration = crypto.randomUUID();
  const commands = new Set(owners.flatMap((owner) => Object.keys(owner.handlers)));
  publishNativeShortcuts({
    version: 1,
    generation: nativeGeneration,
    bindings: paused
      ? []
      : readEffectiveBindings(environment)
          .filter(
            (row) =>
              row.stroke &&
              commands.has(row.command) &&
              [
                "new-chat",
                "new-view",
                "close-view",
                "reopen-view",
                "previous-view",
                "next-view",
                "go-settings",
                "find",
              ].includes(row.command),
          )
          .map((row) => ({
            id: row.id,
            command: row.command,
            stroke: row.stroke!,
            when: row.when,
          })),
  });
}
export function registerShortcutHandlers(
  handlers: Registration["handlers"],
  environment = shortcutEnvironment(),
  priority = 0,
): () => void {
  const registration = { handlers, environment, priority };
  registrations.add(registration);
  notifyCommands();
  if (!detach) {
    const native = onNativeShortcut(dispatchNative);
    window.addEventListener("keydown", dispatchShortcut, true);
    window.addEventListener(KEYBINDINGS_CHANGED, refreshNative);
    window.addEventListener("storage", refreshNative);
    detach = () => {
      native();
      window.removeEventListener("keydown", dispatchShortcut, true);
      window.removeEventListener(KEYBINDINGS_CHANGED, refreshNative);
      window.removeEventListener("storage", refreshNative);
    };
  }
  refreshNative();
  return () => {
    registrations.delete(registration);
    notifyCommands();
    refreshNative();
    if (!registrations.size) {
      detach?.();
      detach = undefined;
    }
  };
}
export function useShortcutHandlers(
  handlers: Registration["handlers"],
  enabled = true,
  isMac = isMacPlatform(),
  priority = 0,
) {
  const latest = useRef(handlers);
  latest.current = handlers;
  const ids = Object.keys(handlers).sort().join(",");
  const { runtime, native } = shortcutEnvironment();
  useEffect(() => {
    if (!enabled) return;
    const wrappers = Object.fromEntries(
      ids
        .split(",")
        .filter(Boolean)
        .map((id) => [
          id,
          (event: KeyboardEvent, current: ShortcutContext) =>
            latest.current[id as CommandId]?.(event, current),
        ]),
    );
    return registerShortcutHandlers(wrappers, { runtime, native, isMac }, priority);
  }, [enabled, ids, isMac, priority, runtime, native]);
}
