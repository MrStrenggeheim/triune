"use strict";

// Native menu and view-management actions use this finite versioned boundary.
const COMMANDS = new Set([
  "new-chat",
  "new-view",
  "close-view",
  "reopen-view",
  "previous-view",
  "next-view",
  "go-settings",
  "find",
]);
const MODIFIERS = ["Ctrl", "Meta", "Alt", "Shift"];
const WHEN = new Set(["workspace", "focused-view", "composer", "editor", "terminal"]);
function isZoom(input) {
  return (
    (input.control || input.meta) &&
    !input.alt &&
    (["+", "=", "-", "_", "0"].includes(input.key) ||
      ["NumpadAdd", "NumpadSubtract", "Numpad0"].includes(input.code))
  );
}
function validateSnapshot(value) {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.generation !== "string" ||
    !value.generation.length ||
    value.generation.length > 80 ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > 100
  )
    return null;
  const bindings = [];
  for (const row of value.bindings) {
    if (
      !row ||
      !COMMANDS.has(row.command) ||
      typeof row.id !== "string" ||
      !row.id.startsWith(`${row.command}:`) ||
      row.id.length > 160 ||
      !WHEN.has(row.when)
    )
      return null;
    const stroke = row.stroke;
    if (
      !stroke ||
      !Array.isArray(stroke.modifiers) ||
      !stroke.modifiers.every((mod) => MODIFIERS.includes(mod))
    )
      return null;
    const match = stroke.match;
    if (
      !match ||
      Object.keys(match).length !== 1 ||
      !(
        (typeof match.key === "string" && match.key.length > 0 && match.key.length < 64) ||
        (typeof match.code === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(match.code))
      )
    )
      return null;
    const modifiers = MODIFIERS.filter((mod) => stroke.modifiers.includes(mod));
    bindings.push({
      id: row.id,
      command: row.command,
      when: row.when,
      stroke: { modifiers, match: { ...match } },
    });
  }
  return { version: 1, generation: value.generation, bindings };
}
function matchInput(snapshot, input) {
  if (
    !snapshot ||
    !input ||
    input.type !== "keyDown" ||
    input.isAutoRepeat ||
    input.isComposing ||
    input.altGraph ||
    input.modifiers?.some((mod) => ["altgr", "altGraph"].includes(mod)) ||
    ["Dead", "Process", "Unidentified", "AltGraph"].includes(input.key) ||
    isZoom(input)
  )
    return null;
  const modifiers = MODIFIERS.filter(
    (mod) => ({ Ctrl: input.control, Meta: input.meta, Alt: input.alt, Shift: input.shift })[mod],
  ).join();
  return (
    snapshot.bindings.find(
      (row) =>
        row.stroke.modifiers.join() === modifiers &&
        ("key" in row.stroke.match
          ? row.stroke.match.key.toLowerCase() === String(input.key).toLowerCase()
          : row.stroke.match.code === input.code),
    ) ?? null
  );
}
function menuAccelerator(row) {
  if (!row) return undefined;
  // Electron accelerators name logical keys; a physical binding cannot be faithfully represented.
  if (!("key" in row.stroke.match)) return undefined;
  const key = row.stroke.match.key;
  const named = { PageUp: "PageUp", PageDown: "PageDown", Enter: "Enter", Escape: "Esc" };
  if (!(key.length === 1 && /^[a-z0-9]$/i.test(key)) && !named[key]) return undefined;
  return [
    ...row.stroke.modifiers.map((mod) =>
      mod === "Meta" ? "Command" : mod === "Ctrl" ? "Control" : mod,
    ),
    named[key] ?? key.toUpperCase(),
  ].join("+");
}
module.exports = { COMMANDS, validateSnapshot, matchInput, menuAccelerator };
