import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KeyboardShortcutsDialog,
  KeyboardShortcutsList,
  openKeyboardShortcuts,
} from "./KeyboardShortcutsDialog";
import { readKeybindingOverrides, shortcutKeys } from "@/lib/keybindingPreferences";
import { registerShortcutHandlers } from "@/lib/shortcutDispatcher";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function changeNewView() {
  fireEvent.click(
    screen.getByRole("button", { name: "Change Add view to focused pane new-view:0" }),
  );
}
describe("editable keyboard shortcuts", () => {
  it("opens from the existing entry, searches the shared execution catalog and displays browser reservations", () => {
    render(<KeyboardShortcutsDialog />);
    expect(screen.queryByRole("table")).toBeNull();
    act(() => openKeyboardShortcuts());
    expect(screen.getByRole("columnheader", { name: "Command" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Keybinding" })).toBeVisible();
    expect(screen.getAllByText(/browser may reserve/i).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByPlaceholderText("Search commands, keys, conditions or source"), {
      target: { value: "new-view" },
    });
    expect(screen.getByText("Add view to focused pane")).toBeVisible();
    expect(screen.queryByText("Close focused view")).toBeNull();
  });
  it("keeps the existing toggle shortcut local to its own modal", () => {
    render(<KeyboardShortcutsDialog />);
    act(() => openKeyboardShortcuts());
    const input = screen.getByRole("textbox", { name: "Search shortcuts" });
    fireEvent.keyDown(input, { key: "/", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("supports manual alternatives, execution/display updates, remove and reset", () => {
    const run = vi.fn();
    const remove = registerShortcutHandlers({ "new-view": run });
    render(<KeyboardShortcutsList variant="settings" />);
    changeNewView();
    fireEvent.change(screen.getByLabelText("Manual key"), { target: { value: "q" } });
    fireEvent.click(screen.getByLabelText("Alt"));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // Unknown physical/logical overlap is never silently accepted.
    if (screen.queryByRole("button", { name: "Replace conflicts" }))
      fireEvent.click(screen.getByRole("button", { name: "Replace conflicts" }));
    expect(shortcutKeys("new-view")).toEqual(["Ctrl", "Alt", "Q"]);
    fireEvent.keyDown(document.body, { key: "q", ctrlKey: true, altKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove new-view:0" }));
    expect(shortcutKeys("new-view")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Reset new-view:0" }));
    expect(shortcutKeys("new-view")).toEqual(["Ctrl", "T"]);
    remove();
  });
  it("requires explicit conflict replacement and persists competing unbindings atomically", () => {
    render(<KeyboardShortcutsList />);
    changeNewView();
    fireEvent.change(screen.getByLabelText("Manual key"), { target: { value: "w" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Resolve");
    expect(readKeybindingOverrides()).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "Replace conflicts" }));
    expect(readKeybindingOverrides()["close-view:0"]).toBeNull();
    expect(shortcutKeys("new-view")).toEqual(["Ctrl", "W"]);
  });
  it("records normalized logical keys and protects IME and zoom", () => {
    render(<KeyboardShortcutsList />);
    changeNewView();
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    fireEvent.keyDown(screen.getByLabelText("Record shortcut"), {
      key: "Q",
      code: "KeyA",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByLabelText("Manual key")).toHaveValue("q");
    expect(screen.getByLabelText("Shift")).toBeChecked();
    fireEvent.change(screen.getByLabelText("Manual key"), { target: { value: "+" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Zoom keys");
  });
  it("keeps mapping active when storage fails", () => {
    render(<KeyboardShortcutsList />);
    changeNewView();
    fireEvent.change(screen.getByLabelText("Manual key"), { target: { value: "n" } });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace conflicts" }));
    expect(screen.getByRole("alert")).toHaveTextContent("previous mappings are still active");
    expect(shortcutKeys("new-view")).toEqual(["Ctrl", "T"]);
  });
});
