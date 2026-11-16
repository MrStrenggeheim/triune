import { isMacPlatform } from "./hotkeys";

export type Runtime = "web" | "electron" | "embedded";
export type Surface = "workbench" | "composer" | "editor" | "terminal" | "modal" | "palette";
export type Modifier = "Ctrl" | "Meta" | "Alt" | "Shift";
export interface Stroke {
  modifiers: readonly Modifier[];
  match: { key: string } | { code: string };
}
export const WHEN = {
  workspace: { label: "Workspace or composer", surfaces: ["workbench", "composer"] },
  "focused-view": {
    label: "Workspace, including editor and terminal",
    surfaces: ["workbench", "composer", "editor", "terminal"],
  },
  composer: { label: "Composer", surfaces: ["composer"] },
  editor: { label: "Editor", surfaces: ["editor"] },
  terminal: { label: "Terminal", surfaces: ["terminal"] },
  modal: { label: "Modal", surfaces: ["modal"] },
  palette: { label: "Command palette", surfaces: ["palette"] },
  "palette-toggle": {
    label: "Workspace or command palette",
    surfaces: ["workbench", "composer", "palette", "terminal"],
  },
} as const satisfies Record<string, { label: string; surfaces: readonly Surface[] }>;
export type WhenId = keyof typeof WHEN;
export interface ShortcutContext {
  runtime: Runtime;
  surface: Surface;
  active: boolean;
  paneId?: string;
  viewId?: string;
}
export const COMMANDS = {
  "new-chat": "New chat",
  "go-inbox": "Go to Inbox",
  "go-tasks": "Go to Automations",
  "go-usage": "Usage and costs",
  "go-projects": "Open Projects",
  "open-changes": "Open Changes",
  "open-search": "Open Search and replace",
  "open-agent-terminal": "Open Agent CLI",
  "open-activity": "Open Orchestration",
  "open-pr": "Open Pull requests",
  "open-automations": "Open Automations",
  "open-browser": "Open Browser",
  "open-logs": "Open Logs",
  "conversation-search": "Search chat messages",
  "conversation-info": "Chat information",
  "conversation-share": "Share chat",
  "conversation-branch": "Branch chat",
  "conversation-stop": "Stop response",
  "cycle-model": "Cycle model",
  "cycle-effort": "Cycle reasoning effort",
  "new-view": "Add view to focused pane",
  "close-view": "Close focused view",
  "reopen-view": "Reopen last closed view",
  "previous-view": "Previous tab in focused pane",
  "next-view": "Next tab in focused pane",
  "command-palette": "Open command palette",
  "session-search": "Find a session by name",
  "go-settings": "Open Settings",
  "keyboard-shortcuts": "Show keyboard shortcuts",
  "toggle-left-sidebar": "Toggle conversations sidebar",
  "toggle-right-sidebar": "Focus or close workspace sidebar",
  "toggle-right-sidebar-direct": "Toggle workspace sidebar",
  "open-files": "Open Files",
  "open-terminal": "Open manual terminal",
  "new-terminal": "Open a new shell",
  "new-browser": "Open a new browser tab",
  find: "Find in current region",
  "workspace-find": "Search workspace contents",
  "workspace-replace": "Replace in workspace",
  "previous-session": "Previous session",
  "next-session": "Next session",
  "rename-session": "Rename current session",
  "toggle-view-mode": "Toggle Chat / Terminal view",
  "focus-composer": "Focus chat input",
  "voice-dictation": "Toggle voice dictation",
  "model-picker": "Open model picker",
  "accept-approval": "Accept approval prompt",
  "pinned-session-1": "Jump to pinned session 1",
  "pinned-session-2": "Jump to pinned session 2",
  "pinned-session-3": "Jump to pinned session 3",
  "pinned-session-4": "Jump to pinned session 4",
  "pinned-session-5": "Jump to pinned session 5",
  "pinned-session-6": "Jump to pinned session 6",
  "pinned-session-7": "Jump to pinned session 7",
  "pinned-session-8": "Jump to pinned session 8",
  "pinned-session-9": "Jump to pinned session 9",
  "pinned-session-0": "Jump to pinned session 10",
} as const;
export type CommandId = keyof typeof COMMANDS;
export type BindingId = `${CommandId}:${string}`;
export interface Binding {
  id: BindingId;
  command: CommandId;
  stroke: Stroke | null;
  when: WhenId;
  source: "Default" | "User";
}
export type BindingOverride = { stroke: Stroke; when: WhenId } | null;
export type Overrides = Partial<Record<BindingId, BindingOverride>>;
export interface BindingEnvironment {
  isMac: boolean;
  native: boolean;
  runtime: Runtime;
}
export function isCommandId(value: string): value is CommandId {
  return Object.hasOwn(COMMANDS, value);
}
export function normalizeKey(key: string): string {
  const aliases: Record<string, string> = {
    esc: "Escape",
    spacebar: " ",
    space: " ",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    add: "+",
    subtract: "-",
    del: "Delete",
  };
  const named = [
    "Escape",
    "Enter",
    "Tab",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "ContextMenu",
    ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  ];
  return (
    aliases[key.toLowerCase()] ??
    named.find((name) => name.toLowerCase() === key.toLowerCase()) ??
    (key.length === 1 ? key.toLowerCase() : key)
  );
}
export function normalizeStroke(stroke: Stroke): Stroke {
  const modifiers = (["Ctrl", "Meta", "Alt", "Shift"] as const).filter((value) =>
    stroke.modifiers.includes(value),
  );
  return {
    modifiers,
    match:
      "key" in stroke.match ? { key: normalizeKey(stroke.match.key) } : { code: stroke.match.code },
  };
}
export function eventStroke(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): Stroke {
  return normalizeStroke({
    modifiers: [
      event.ctrlKey && "Ctrl",
      event.metaKey && "Meta",
      event.altKey && "Alt",
      event.shiftKey && "Shift",
    ].filter(Boolean) as Modifier[],
    match: { key: event.key },
  });
}
export function isZoomStroke(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">,
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    (["+", "=", "-", "_", "0"].includes(normalizeKey(event.key)) ||
      ["NumpadAdd", "NumpadSubtract", "Numpad0"].includes(event.code))
  );
}
export function matchesStroke(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  stroke: Stroke,
): boolean {
  const normalized = normalizeStroke(stroke);
  return (
    eventStroke(event).modifiers.join() === normalized.modifiers.join() &&
    ("key" in normalized.match
      ? normalizeKey(event.key) === normalized.match.key
      : event.code === normalized.match.code)
  );
}
export function defaultBindings(environment: BindingEnvironment): Binding[] {
  const mod: Modifier = environment.isMac ? "Meta" : "Ctrl";
  const rows: Binding[] = [];
  function add(
    command: CommandId,
    key: string,
    modifiers: Modifier[] = [mod],
    when: WhenId = "workspace",
    code = false,
  ) {
    rows.push({
      id: `${command}:${rows.filter((row) => row.command === command).length}`,
      command,
      stroke: normalizeStroke({ modifiers, match: code ? { code: key } : { key } }),
      when,
      source: "Default",
    });
  }
  for (const [command, key] of [
    ["new-chat", "n"],
    ["new-view", "t"],
    ["close-view", "w"],
  ] as const)
    add(command, key, [mod], "focused-view");
  add(
    "new-chat",
    environment.native ? "KeyN" : "o",
    environment.native ? [mod, "Alt"] : [mod, "Shift"],
    "focused-view",
    environment.native,
  );
  add("reopen-view", "t", [mod, "Shift"], "focused-view");
  add("previous-view", "PageUp", ["Ctrl"], "focused-view");
  add("next-view", "PageDown", ["Ctrl"], "focused-view");
  add("command-palette", "k", [mod], "palette-toggle");
  add("session-search", "KeyS", [mod, "Alt"], "workspace", true);
  add("go-settings", "Comma", [mod, "Alt"], "focused-view", true);
  add("keyboard-shortcuts", "/");
  add("toggle-left-sidebar", "KeyB", [mod], "focused-view", true);
  add("toggle-left-sidebar", "BracketLeft", [mod, "Alt"], "focused-view", true);
  add("toggle-right-sidebar", "BracketRight", [mod, "Alt"], "focused-view", true);
  add("toggle-right-sidebar-direct", "KeyI", [mod], "focused-view", true);
  add("open-files", "e", [mod], "focused-view");
  add("open-terminal", "KeyJ", [mod], "focused-view", true);
  add("new-terminal", "KeyT", [mod, "Alt"], "workspace", true);
  add("new-browser", "KeyB", [mod, "Alt"], "workspace", true);
  add("find", "f", [mod], "workspace");
  add("workspace-find", "f", [mod, "Shift"], "focused-view");
  add("workspace-replace", "h", [mod, "Shift"], "focused-view");
  add("previous-session", "[");
  add("next-session", "]");
  add("rename-session", "KeyR", [mod, "Alt"], "workspace", true);
  add("toggle-view-mode", "Backslash", [mod, "Alt"], "focused-view", true);
  add("focus-composer", "KeyL", ["Ctrl", "Shift"], "workspace", true);
  add("voice-dictation", "KeyV", [mod, "Alt"], "workspace", true);
  add("model-picker", "KeyM", ["Ctrl", "Shift"], "workspace", true);
  add("accept-approval", "Enter", [mod], "workspace");
  add("cycle-model", "KeyM", ["Ctrl", "Alt"], "workspace", true);
  add("cycle-effort", "KeyE", ["Ctrl", "Alt"], "workspace", true);
  for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const)
    add(
      `pinned-session-${digit}`,
      environment.native ? digit : `Digit${digit}`,
      environment.native ? [mod] : [mod, "Alt"],
      "focused-view",
      !environment.native,
    );
  // Ctrl/Cmd+0 always resets zoom, including in native windows.
  if (environment.native) {
    const tenth = rows.find((row) => row.command === "pinned-session-0");
    if (tenth) tenth.stroke = null;
  }
  for (const command of Object.keys(COMMANDS) as CommandId[])
    if (!rows.some((row) => row.command === command))
      rows.push({
        id: `${command}:0`,
        command,
        stroke: null,
        when: "workspace",
        source: "Default",
      });
  return rows;
}
export function effectiveBindings(
  environment: BindingEnvironment,
  overrides: Overrides = {},
): Binding[] {
  const defaults = defaultBindings(environment);
  const known = new Set(defaults.map((row) => row.id));
  return [
    ...defaults.map((row) =>
      Object.hasOwn(overrides, row.id)
        ? {
            ...row,
            stroke: overrides[row.id]?.stroke ?? null,
            when: overrides[row.id]?.when ?? row.when,
            source: "User" as const,
          }
        : row,
    ),
    ...Object.entries(overrides).flatMap(([id, value]) => {
      const command = id.slice(0, id.lastIndexOf(":"));
      return !known.has(id as BindingId) && isCommandId(command) && value
        ? [{ id: id as BindingId, command, ...value, source: "User" as const }]
        : [];
    }),
  ];
}
export function whenMatches(when: WhenId, surface: Surface): boolean {
  return (WHEN[when].surfaces as readonly Surface[]).includes(surface);
}
export function compatibleWhen(
  row: Binding,
  when: WhenId,
  environment: BindingEnvironment,
): boolean {
  const allowed =
    defaultBindings(environment).find((item) => item.command === row.command)?.when ?? "workspace";
  return (WHEN[when].surfaces as readonly Surface[]).every((surface) =>
    whenMatches(allowed, surface),
  );
}
export function bindingConflicts(candidate: Binding, rows: readonly Binding[]): Binding[] {
  if (!candidate.stroke) return [];
  const left = normalizeStroke(candidate.stroke);
  return rows.filter((row) => {
    if (
      row.id === candidate.id ||
      !row.stroke ||
      !(WHEN[row.when].surfaces as readonly Surface[]).some((surface) =>
        whenMatches(candidate.when, surface),
      )
    )
      return false;
    const right = normalizeStroke(row.stroke);
    if (left.modifiers.join() !== right.modifiers.join()) return false;
    // A physical and logical pair can overlap on another keyboard layout.
    return "key" in left.match && "key" in right.match
      ? left.match.key === right.match.key
      : "code" in left.match && "code" in right.match
        ? left.match.code === right.match.code
        : true;
  });
}
export function bindingKeys(stroke: Stroke | null, isMac = isMacPlatform()): string[] {
  if (!stroke) return [];
  const labels: Record<string, string> = {
    Ctrl: isMac ? "⌃" : "Ctrl",
    Meta: "⌘",
    Alt: isMac ? "⌥" : "Alt",
    Shift: "⇧",
    Enter: "↵",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    " ": "Space",
  };
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
    ...stroke.modifiers.map((modifier) => labels[modifier]),
    labels[key] ?? (key.length === 1 ? key.toUpperCase() : key),
  ];
}
export function bindingAvailability(
  row: Binding,
  environment: BindingEnvironment,
  nativeSupported: boolean,
): string | null {
  if (!row.stroke) return null;
  if (
    environment.runtime === "electron" &&
    !nativeSupported &&
    ["new-view", "close-view", "reopen-view", "previous-view", "next-view"].includes(row.command)
  )
    return "This desktop shell cannot route view shortcuts; update it or use the view menu.";
  const key = "key" in row.stroke.match ? row.stroke.match.key.toLowerCase() : "";
  if (
    environment.runtime !== "electron" &&
    !row.stroke.modifiers.includes("Alt") &&
    ["t", "n", "w", "PageUp", "PageDown"].some((value) => value.toLowerCase() === key)
  )
    return "The browser may reserve this shortcut. Choose an alternative if it does not reach Triune.";
  return null;
}
