import { useEffect, useState } from "react";
import {
  Kbd,
  composerSendShortcutKeys,
  composerNewLineShortcutKeys,
  composerSteerAllShortcutKeys,
} from "@/components/KeyboardShortcut";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  COMMANDS,
  WHEN,
  bindingAvailability,
  bindingConflicts,
  bindingKeys,
  compatibleWhen,
  eventStroke,
  isZoomStroke,
  normalizeStroke,
  type Binding,
  type BindingId,
  type Stroke,
  type WhenId,
} from "@/lib/keybindingRegistry";
import {
  matchesShortcutCommand,
  readKeybindingOverrides,
  shortcutEnvironment,
  useEffectiveBindings,
  writeKeybindingOverrides,
} from "@/lib/keybindingPreferences";
import {
  pauseShortcutDispatch,
  useShortcutHandlers,
  useRegisteredShortcutCommands,
} from "@/lib/shortcutDispatcher";
import { supportsNativeShortcuts } from "@/lib/nativeBridge";
import { readSubmitWithModEnter } from "@/lib/composerSendShortcutPreferences";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";

export const KEYBOARD_SHORTCUTS_EVENT = "omnigent:open-keyboard-shortcuts";
export function openKeyboardShortcuts(): void {
  window.dispatchEvent(new Event(KEYBOARD_SHORTCUTS_EVENT));
}

export function KeyboardShortcutsList({
  variant = "compact",
}: {
  variant?: "compact" | "settings";
}) {
  const rows = useEffectiveBindings();
  const availableCommands = useRegisteredShortcutCommands();
  const environment = shortcutEnvironment();
  const [query, setQuery] = useState("");
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [editing, setEditing] = useState<BindingId | null>(null);
  const [draft, setDraft] = useState<Stroke>({ modifiers: [], match: { key: "" } });
  const [when, setWhen] = useState<WhenId>("workspace");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobileViewport();
  const isCoarse = useIsCoarsePointer();
  const row = rows.find((item) => item.id === editing);
  const candidate = row ? { ...row, stroke: normalizeStroke(draft), when } : null;
  const conflicts = candidate ? bindingConflicts(candidate, rows) : [];
  const reserved = candidate
    ? bindingAvailability(candidate, environment, supportsNativeShortcuts())
    : null;
  useEffect(() => (recording ? pauseShortcutDispatch() : undefined), [recording]);
  function begin(item: Binding) {
    setEditing(item.id);
    setDraft(item.stroke ?? { modifiers: [], match: { key: "" } });
    setWhen(item.when);
    setRecording(false);
    setError(null);
  }
  function save(replace = false) {
    if (!candidate) return;
    const key = "key" in draft.match ? draft.match.key : draft.match.code;
    if (
      !key.trim() ||
      ["Control", "Alt", "Shift", "Meta", "Dead", "Process", "Unidentified"].includes(key)
    ) {
      setError("Choose a key as well as any modifiers.");
      return;
    }
    if ("code" in draft.match && !/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) {
      setError("Enter a physical key code such as KeyT or BracketRight.");
      return;
    }
    if (
      isZoomStroke({
        key: "key" in draft.match ? key : "",
        code: "code" in draft.match ? key : "",
        ctrlKey: draft.modifiers.includes("Ctrl"),
        metaKey: draft.modifiers.includes("Meta"),
        altKey: draft.modifiers.includes("Alt"),
      })
    ) {
      setError("Zoom keys are reserved for zoom. Choose another shortcut.");
      return;
    }
    if (conflicts.length && !replace) {
      setError("Resolve the conflicting bindings or choose Replace conflicts.");
      return;
    }
    const overrides = readKeybindingOverrides();
    for (const conflict of replace ? conflicts : []) overrides[conflict.id] = null;
    overrides[candidate.id] = { stroke: candidate.stroke!, when };
    if (!writeKeybindingOverrides(overrides)) {
      setError("Could not save shortcuts. Your previous mappings are still active.");
      return;
    }
    setEditing(null);
    setRecording(false);
    setError(null);
  }
  function mutate(id: BindingId | null, reset: boolean) {
    const overrides = readKeybindingOverrides();
    if (id && reset) {
      Reflect.deleteProperty(overrides, id);
    } else if (id) overrides[id] = null;
    if (!writeKeybindingOverrides(id ? overrides : {}))
      setError("Could not save shortcuts. Your previous mappings are still active.");
    else setError(null);
  }
  const visible = rows.filter((item) => {
    const text = [
      COMMANDS[item.command],
      item.command,
      bindingKeys(item.stroke, environment.isMac).join("+"),
      WHEN[item.when].label,
      item.source,
    ]
      .join(" ")
      .toLowerCase();
    return (
      text.includes(query.toLowerCase().trim()) &&
      (!conflictsOnly || bindingConflicts(item, rows).length > 0)
    );
  });
  return (
    <div className="flex min-h-0 flex-col gap-3" data-shortcut-editor={variant}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search shortcuts"
          placeholder="Search commands, keys, conditions or source"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-48 flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          aria-pressed={conflictsOnly}
          onClick={() => setConflictsOnly(!conflictsOnly)}
        >
          Conflicts
        </Button>
        <Button size="sm" variant="outline" onClick={() => mutate(null, true)}>
          Reset all
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Bindings apply to this viewer, server and platform. Browsers may reserve tab and window
        keys; use Change to assign an alternative.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {row && (
        <section
          aria-label={`Change ${COMMANDS[row.command]}`}
          className="flex flex-col gap-3 rounded-md border border-border bg-card p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{COMMANDS[row.command]}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRecording(!recording);
              }}
            >
              {recording ? "Stop recording" : "Record shortcut"}
            </Button>
          </div>
          <Input
            aria-label="Record shortcut"
            readOnly
            value={
              recording
                ? "Press the shortcut here"
                : bindingKeys(draft, environment.isMac).join("+")
            }
            onKeyDown={(event) => {
              if (!recording) return;
              event.preventDefault();
              event.stopPropagation();
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.getModifierState("AltGraph") ||
                ["Dead", "Process", "Control", "Meta", "Alt", "Shift"].includes(event.key)
              )
                return;
              setDraft(eventStroke(event.nativeEvent));
              setRecording(false);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <label className="text-xs">
              Match{" "}
              <select
                aria-label="Key match"
                className="rounded border border-border bg-background p-2 text-sm"
                value={"key" in draft.match ? "key" : "code"}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    match: event.target.value === "key" ? { key: "" } : { code: "" },
                  })
                }
              >
                <option value="key">Logical key</option>
                <option value="code">Physical code</option>
              </select>
            </label>
            <label className="min-w-36 flex-1 text-xs">
              Key{" "}
              <Input
                aria-label="Manual key"
                list="shortcut-key-options"
                value={"key" in draft.match ? draft.match.key : draft.match.code}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    match:
                      "key" in draft.match
                        ? { key: event.target.value }
                        : { code: event.target.value },
                  })
                }
              />
            </label>
            <datalist id="shortcut-key-options">
              {[
                "t",
                "n",
                "w",
                "PageUp",
                "PageDown",
                "Enter",
                "Escape",
                "ArrowUp",
                "ArrowDown",
                "KeyT",
                "BracketRight",
              ].map((key) => (
                <option key={key} value={key} />
              ))}
            </datalist>
          </div>
          <div className="flex flex-wrap gap-3">
            {(["Ctrl", "Meta", "Alt", "Shift"] as const).map((modifier) => (
              <label key={modifier} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={draft.modifiers.includes(modifier)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      modifiers: event.target.checked
                        ? [...draft.modifiers, modifier]
                        : draft.modifiers.filter((value) => value !== modifier),
                    })
                  }
                />
                {modifier}
              </label>
            ))}
          </div>
          <label className="text-sm">
            When{" "}
            <select
              aria-label="When"
              className="rounded border border-border bg-background p-2 text-sm"
              value={when}
              onChange={(event) => setWhen(event.target.value as WhenId)}
            >
              {(Object.keys(WHEN) as WhenId[])
                .filter((value) => compatibleWhen(row, value, environment))
                .map((value) => (
                  <option value={value} key={value}>
                    {WHEN[value].label}
                  </option>
                ))}
            </select>
          </label>
          {reserved && <p className="text-xs text-muted-foreground">{reserved}</p>}
          {conflicts.length > 0 && (
            <p role="status" className="text-sm">
              Conflicts with {conflicts.map((item) => COMMANDS[item.command]).join(", ")}. Physical
              and logical bindings may overlap on another layout.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => save()}>
              Save
            </Button>
            {conflicts.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => save(true)}>
                Replace conflicts
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(null);
                setRecording(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </section>
      )}
      <div className="min-h-0 max-h-[55vh] overflow-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-popover text-muted-foreground">
            <tr>
              {["Command", "Keybinding", "When", "Source", "Actions"].map((label) => (
                <th key={label} className="px-3 py-2 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => {
              const availability = bindingAvailability(
                item,
                environment,
                supportsNativeShortcuts(),
              );
              return (
                <tr key={item.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <span>{COMMANDS[item.command]}</span>
                    <span className="block text-xs text-muted-foreground">{item.command}</span>
                    {!availableCommands.includes(item.command) && (
                      <span className="block text-xs text-muted-foreground">
                        Unavailable in current view
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      aria-label={`Change ${COMMANDS[item.command]} ${item.id}`}
                      onClick={() => begin(item)}
                      className="flex gap-1 rounded focus-visible:outline-ring"
                    >
                      {item.stroke
                        ? bindingKeys(item.stroke, environment.isMac).map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))
                        : "Unbound"}
                    </button>
                    {availability && (
                      <span className="mt-1 block max-w-64 text-xs text-muted-foreground">
                        {availability}
                      </span>
                    )}
                    {item.stroke && "code" in item.stroke.match && (
                      <span className="block text-xs text-muted-foreground">
                        Physical: {item.stroke.match.code}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {WHEN[item.when].label}
                  </td>
                  <td className="px-3 py-2">{item.source}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${item.id}`}
                        disabled={!item.stroke}
                        onClick={() => mutate(item.id, false)}
                      >
                        Remove
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Reset ${item.id}`}
                        disabled={item.source === "Default"}
                        onClick={() => mutate(item.id, true)}
                      >
                        Reset
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visible.length && (
          <p className="p-3 text-sm text-muted-foreground">No matching shortcuts.</p>
        )}
      </div>
      {!isMobile && !isCoarse && (
        <details className="text-sm">
          <summary>Composer controls</summary>
          <ul className="mt-2 space-y-2">
            {[
              ["Send message", composerSendShortcutKeys(readSubmitWithModEnter())],
              [
                "Send now, with all queued messages",
                composerSteerAllShortcutKeys(readSubmitWithModEnter()),
              ],
              ["New line in message", composerNewLineShortcutKeys(readSubmitWithModEnter())],
            ].map(([label, keys]) => (
              <li key={label as string} className="flex items-center justify-between gap-2">
                <span>{label}</span>
                <span className="flex gap-1">
                  {(keys as string[]).map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  useShortcutHandlers({ "keyboard-shortcuts": () => setOpen((previous) => !previous) });
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(KEYBOARD_SHORTCUTS_EVENT, onOpen);
    return () => window.removeEventListener(KEYBOARD_SHORTCUTS_EVENT, onOpen);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="flex max-h-[90vh] flex-col sm:max-w-5xl"
        onKeyDownCapture={(event) => {
          if (matchesShortcutCommand(event.nativeEvent, "keyboard-shortcuts")) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Search, change, remove or reset workspace keybindings.
          </DialogDescription>
        </DialogHeader>
        <KeyboardShortcutsList />
      </DialogContent>
    </Dialog>
  );
}
