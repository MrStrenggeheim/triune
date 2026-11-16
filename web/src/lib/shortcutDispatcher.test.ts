import type { NativeShortcutSnapshot, NativeShortcutRequest } from "./nativeBridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchShortcut,
  registerShortcutHandlers,
  pauseShortcutDispatch,
} from "./shortcutDispatcher";
import {
  keybindingStorageKey,
  readKeybindingOverrides,
  writeKeybindingOverrides,
  shortcutKeys,
} from "./keybindingPreferences";

const environment = { isMac: false, native: false, runtime: "web" as const };
const cleanups: (() => void)[] = [];

const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
describe("one shortcut dispatcher", () => {
  it("executes the live guarded owner once and never falls through to the global new-chat alias", () => {
    const fallback = vi.fn();
    const guarded = vi.fn();
    cleanups.push(registerShortcutHandlers({ "new-chat": fallback }, environment));
    cleanups.push(registerShortcutHandlers({ "new-chat": guarded }, environment, 10));
    press({ key: "n", ctrlKey: true });
    expect(guarded).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("uses saved overrides immediately for execution and display, removes old key, resets", () => {
    const run = vi.fn();
    cleanups.push(registerShortcutHandlers({ "new-view": run }, environment));
    expect(
      writeKeybindingOverrides(
        {
          "new-view:0": {
            stroke: { modifiers: ["Ctrl", "Alt"], match: { key: "x" } },
            when: "workspace",
          },
        },
        keybindingStorageKey(environment),
      ),
    ).toBe(true);
    press({ key: "t", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
    press({ key: "x", ctrlKey: true, altKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(shortcutKeys("new-view", environment)).toEqual(["Ctrl", "Alt", "X"]);
    writeKeybindingOverrides({}, keybindingStorageKey(environment));
    press({ key: "t", ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("keeps scope and failed writes isolated", () => {
    const key = keybindingStorageKey(environment, "alice", "server-a");
    writeKeybindingOverrides({ "new-view:0": null }, key);
    expect(readKeybindingOverrides(key)).toEqual({ "new-view:0": null });
    expect(readKeybindingOverrides(keybindingStorageKey(environment, "bob", "server-a"))).toEqual(
      {},
    );
    expect(
      readKeybindingOverrides(
        keybindingStorageKey({ ...environment, runtime: "electron" }, "alice", "server-a"),
      ),
    ).toEqual({});
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(writeKeybindingOverrides({ "close-view:0": null }, key)).toBe(false);
    expect(readKeybindingOverrides(key)).toEqual({ "new-view:0": null });
  });
  it("preserves terminal/editor ownership, modal ownership, IME, AltGraph and consumed input", () => {
    const session = vi.fn();
    const close = vi.fn();
    cleanups.push(
      registerShortcutHandlers({ "next-session": session, "close-view": close }, environment),
    );
    const editor = document.createElement("input");
    editor.className = "monaco-editor";
    document.body.append(editor);
    editor.focus();
    press({ key: "]", code: "BracketRight", ctrlKey: true });
    expect(session).not.toHaveBeenCalled();
    press({ key: "w", ctrlKey: true });
    expect(close).toHaveBeenCalledTimes(1);
    editor.className = "xterm";
    press({ key: "]", ctrlKey: true });
    expect(session).not.toHaveBeenCalled();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.dataset.state = "open";
    document.body.append(dialog);
    press({ key: "w", ctrlKey: true });
    expect(close).toHaveBeenCalledTimes(1);
    dialog.remove();
    press({ key: "w", ctrlKey: true, isComposing: true });
    const consumed = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, cancelable: true });
    consumed.preventDefault();
    expect(dispatchShortcut(consumed)).toBe(false);
    const altGraph = new KeyboardEvent("keydown", { key: "w", ctrlKey: true });
    vi.spyOn(altGraph, "getModifierState").mockReturnValue(true);
    expect(dispatchShortcut(altGraph)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("leaves zoom and Ctrl+Tab untouched and pauses background execution while recording", () => {
    const run = vi.fn();
    cleanups.push(registerShortcutHandlers({ "next-session": run, "new-view": run }, environment));
    for (const key of ["+", "=", "-", "_", "0"])
      expect(press({ key, code: "BracketRight", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "Tab", ctrlKey: true }).defaultPrevented).toBe(false);
    const resume = pauseShortcutDispatch();
    press({ key: "t", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
    resume();
    press({ key: "t", ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("imported conflict precedence", () => {
  it("prefers a user mapping across command owners, then the narrower context", () => {
    const user = vi.fn();
    const builtIn = vi.fn();
    cleanups.push(registerShortcutHandlers({ "new-chat": builtIn }, environment, 10));
    cleanups.push(registerShortcutHandlers({ "new-view": user }, environment));
    writeKeybindingOverrides(
      { "new-view:0": { stroke: { modifiers: ["Ctrl"], match: { key: "n" } }, when: "workspace" } },
      keybindingStorageKey(environment),
    );
    press({ key: "n", ctrlKey: true });
    expect(user).toHaveBeenCalledTimes(1);
    expect(builtIn).not.toHaveBeenCalled();
  });
});

describe("native command generation", () => {
  it("rejects stale native requests and sends current requests through the same guarded action", () => {
    const snapshots: NativeShortcutSnapshot[] = [];
    let receive: ((request: NativeShortcutRequest) => void) | undefined;
    const bridge = {
      kind: "electron",
      shortcutProtocolVersion: 1,
      setShortcutBindings: (snapshot: NativeShortcutSnapshot) => snapshots.push(snapshot),
      onShortcutCommand: (callback: typeof receive) => {
        receive = callback;
        return () => {};
      },
    };
    const shell = window as unknown as Record<string, unknown>;
    const previous = shell.omnigentDesktop;
    shell.omnigentDesktop = bridge;
    const run = vi.fn();
    const dispose = registerShortcutHandlers(
      { "close-view": run },
      { isMac: false, native: true, runtime: "electron" },
    );
    try {
      const first = snapshots.at(-1)!;
      receive!({ version: 1, generation: "stale", command: "close-view" });
      expect(run).not.toHaveBeenCalled();
      receive!({
        version: 1,
        generation: first.generation,
        command: "close-view",
        stroke: {
          key: "w",
          code: "KeyW",
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
        },
      });
      expect(run).toHaveBeenCalledTimes(1);
      const field = document.createElement("textarea");
      document.body.append(field);
      field.focus();
      writeKeybindingOverrides(
        {
          "close-view:0": {
            stroke: { modifiers: ["Ctrl"], match: { key: "w" } },
            when: "composer",
          },
        },
        keybindingStorageKey({ isMac: false, native: true, runtime: "electron" }),
      );
      receive!({
        version: 1,
        generation: snapshots.at(-1)!.generation,
        command: "close-view",
        surface: "workbench",
        stroke: {
          key: "w",
          code: "KeyW",
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
        },
      });
      expect(run).toHaveBeenCalledTimes(1);
      writeKeybindingOverrides(
        { "close-view:0": null },
        keybindingStorageKey({ isMac: false, native: true, runtime: "electron" }),
      );
      receive!({ version: 1, generation: first.generation, command: "close-view" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(snapshots.at(-1)!.bindings.some((row) => row.command === "close-view")).toBe(false);
    } finally {
      dispose();
      shell.omnigentDesktop = previous;
    }
  });
});
