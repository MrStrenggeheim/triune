"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateSnapshot, matchInput, menuAccelerator } = require("../src/shortcutProtocol");

const snapshot = () => ({
  version: 1,
  generation: "viewer-generation",
  bindings: [
    {
      id: "close-view:0",
      command: "close-view",
      when: "focused-view",
      stroke: { modifiers: ["Ctrl"], match: { key: "w" } },
    },
  ],
});
describe("versioned native shortcut data", () => {
  it("accepts only finite commands and data, not executable or foreign payloads", () => {
    assert.deepEqual(validateSnapshot(snapshot()), snapshot());
    for (const value of [
      { ...snapshot(), version: 2 },
      { ...snapshot(), generation: 3 },
      { ...snapshot(), bindings: [{ ...snapshot().bindings[0], command: "quit" }] },
      { ...snapshot(), bindings: [{ ...snapshot().bindings[0], when: "eval(true)" }] },
      {
        ...snapshot(),
        bindings: [
          { ...snapshot().bindings[0], stroke: { modifiers: ["Hyper"], match: { key: "w" } } },
        ],
      },
    ])
      assert.equal(validateSnapshot(value), null);
  });
  it("matches effective logical keys with exact modifiers and preserves zoom", () => {
    const saved = validateSnapshot(snapshot());
    assert.equal(
      matchInput(saved, { type: "keyDown", key: "w", control: true }).command,
      "close-view",
    );
    assert.equal(
      matchInput(saved, { type: "keyDown", key: "w", control: true, shift: true }),
      null,
    );
    assert.equal(matchInput(saved, { type: "keyDown", key: "w", control: true, meta: true }), null);
    for (const key of ["+", "=", "-", "_", "0"])
      assert.equal(
        matchInput(saved, { type: "keyDown", key, code: "BracketRight", control: true }),
        null,
      );
    assert.equal(menuAccelerator(saved.bindings[0]), "Control+W");
    assert.equal(
      menuAccelerator({
        ...saved.bindings[0],
        stroke: { modifiers: ["Ctrl"], match: { code: "BracketRight" } },
      }),
      undefined,
    );
  });
  it("uses the remapped stroke and ignores release/repeat input", () => {
    const value = snapshot();
    value.bindings[0].stroke = { modifiers: ["Ctrl", "Alt"], match: { key: "x" } };
    const saved = validateSnapshot(value);
    assert.equal(matchInput(saved, { type: "keyDown", key: "w", control: true }), null);
    assert.equal(
      matchInput(saved, { type: "keyDown", key: "x", control: true, alt: true }).command,
      "close-view",
    );
    assert.equal(matchInput(saved, { type: "keyUp", key: "x", control: true, alt: true }), null);
    assert.equal(
      matchInput(saved, {
        type: "keyDown",
        key: "x",
        control: true,
        alt: true,
        isAutoRepeat: true,
      }),
      null,
    );
  });
});
