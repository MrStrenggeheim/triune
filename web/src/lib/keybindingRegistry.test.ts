import { describe, expect, it } from "vitest";
import {
  bindingConflicts,
  defaultBindings,
  effectiveBindings,
  isZoomStroke,
  matchesStroke,
  normalizeStroke,
  type Binding,
  type BindingEnvironment,
} from "./keybindingRegistry";

const environment: BindingEnvironment = { isMac: false, native: false, runtime: "web" };
const event = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
describe("effective shortcut registry", () => {
  it("uses exact modifiers and logical characters while preserving explicit Option codes", () => {
    const rows = defaultBindings(environment);
    const next = rows.find((row) => row.command === "next-session")!;
    expect(
      matchesStroke(event({ key: "+", code: "BracketRight", ctrlKey: true }), next.stroke!),
    ).toBe(false);
    expect(matchesStroke(event({ key: "]", code: "Equal", ctrlKey: true }), next.stroke!)).toBe(
      true,
    );
    expect(
      matchesStroke(
        event({ key: "]", code: "Equal", ctrlKey: true, shiftKey: true }),
        next.stroke!,
      ),
    ).toBe(false);
    const shell = defaultBindings({ ...environment, isMac: true }).find(
      (row) => row.command === "new-terminal",
    )!;
    expect(
      matchesStroke(event({ key: "†", code: "KeyT", metaKey: true, altKey: true }), shell.stroke!),
    ).toBe(true);
    expect(normalizeStroke({ modifiers: ["Shift", "Ctrl", "Ctrl"], match: { key: "A" } })).toEqual({
      modifiers: ["Ctrl", "Shift"],
      match: { key: "a" },
    });
  });
  it.each(["+", "=", "-", "_", "0"])(
    "protects logical zoom %s regardless of physical position",
    (key) => {
      expect(
        isZoomStroke({ key, code: "BracketRight", ctrlKey: true, metaKey: false, altKey: false }),
      ).toBe(true);
    },
  );
  it("detects overlapping conditions and possible physical/logical conflicts, permits disjoint conditions", () => {
    const row: Binding = {
      id: "new-view:0",
      command: "new-view",
      stroke: { modifiers: ["Ctrl"], match: { key: "t" } },
      when: "composer",
      source: "User",
    };
    const other: Binding = {
      ...row,
      id: "close-view:0",
      command: "close-view",
      when: "focused-view",
    };
    expect(bindingConflicts(row, [other])).toEqual([other]);
    expect(bindingConflicts(row, [{ ...other, when: "editor" }])).toEqual([]);
    expect(
      bindingConflicts(row, [
        { ...other, stroke: { modifiers: ["Ctrl"], match: { code: "KeyW" } } },
      ]),
    ).toHaveLength(1);
  });
  it("applies sparse explicit unbinding and reset while preserving customized defaults", () => {
    const rows = effectiveBindings(environment, { "new-view:0": null });
    expect(rows.find((row) => row.id === "new-view:0")?.stroke).toBeNull();
    expect(rows.find((row) => row.id === "go-settings:0")?.stroke?.match).toEqual({
      code: "Comma",
    });
    expect(
      effectiveBindings(environment).find((row) => row.id === "new-view:0")?.stroke?.match,
    ).toEqual({ key: "t" });
  });
});
