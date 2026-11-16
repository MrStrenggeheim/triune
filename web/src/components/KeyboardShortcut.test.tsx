import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompactShortcutKeys,
  commandAriaShortcut,
  newSessionShortcutKeys,
} from "./KeyboardShortcut";
import { writeKeybindingOverrides } from "@/lib/keybindingPreferences";

beforeEach(() => localStorage.clear());
afterEach(cleanup);
describe("registry shortcut chips", () => {
  it("updates chips and accessible keys when a mapping changes or is removed", () => {
    render(
      <div data-testid="keys">
        <CompactShortcutKeys command="new-chat" />
      </div>,
    );
    expect(newSessionShortcutKeys()).toEqual(["Ctrl", "N"]);
    act(() => {
      writeKeybindingOverrides({
        "new-chat:0": {
          stroke: { modifiers: ["Ctrl", "Alt"], match: { key: "x" } },
          when: "workspace",
        },
      });
    });
    expect(screen.getByTestId("keys")).toHaveTextContent("CtrlAltX");
    expect(commandAriaShortcut("new-chat")).toBe("Control+Alt+x");
    act(() => {
      writeKeybindingOverrides({ "new-chat:0": null, "new-chat:1": null });
    });
    expect(screen.getByTestId("keys").querySelectorAll("kbd")).toHaveLength(0);
    expect(commandAriaShortcut("new-chat")).toBe("");
  });
});
