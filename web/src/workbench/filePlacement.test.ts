// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { describe, expect, it } from "vitest";
import { addDockView, createDockLayout } from "./dockLayout";
import { filePlacement, previewPlacement } from "./filePlacement";

const chat = { id: "chat", kind: "conversation", title: "Chat", resource: { conversationId: "a" } };
const files = { id: "files", kind: "files", title: "Files", resource: { path: "/workspace" } };
describe("chat file destination preference", () => {
  it("splits a full-width chat once and then reuses its side pane", () => {
    const initial = createDockLayout([chat]);
    expect(filePlacement(initial, "main", "beside")).toEqual({ paneId: "main", edge: "right" });
    const side = addDockView(initial, files, { edge: "right" });
    expect(filePlacement(side, "main", "beside")).toEqual({ paneId: "pane-1" });
    expect(filePlacement(side, "main", "reuse")).toEqual({ paneId: "pane-1" });
    expect(filePlacement(side, "main", "same")).toEqual({ paneId: "main" });
    expect(filePlacement(side, "main", "split")).toEqual({ paneId: "main", edge: "right" });
  });
  it("respects pinned reservations and does not select a pane below as beside", () => {
    const side = addDockView(createDockLayout([chat]), files, { edge: "right" });
    expect(filePlacement(side, "main", "beside", ["files"])).toEqual({
      paneId: "main",
      edge: "right",
    });
    const below = addDockView(createDockLayout([chat]), files, { edge: "bottom" });
    expect(filePlacement(below, "main", "beside")).toEqual({ paneId: "main", edge: "right" });
    expect(filePlacement(below, "main", "reuse")).toEqual({ paneId: "pane-1" });
  });
  it("uses the adjacent pane instead of a farther file pane", () => {
    const side = addDockView(createDockLayout([chat]), files, { edge: "right" });
    const between = addDockView(
      side,
      { ...chat, id: "other-chat" },
      { paneId: "pane-1", edge: "left" },
    );
    expect(filePlacement(between, "main", "beside")).toEqual({ paneId: "pane-2" });
    expect(filePlacement(between, "main", "reuse")).toEqual({ paneId: "pane-1" });
  });
  it("prefers the source file pane for Reuse even when another file pane exists", () => {
    const side = addDockView(createDockLayout([chat]), files, { edge: "right" });
    const layout = addDockView(side, { ...files, id: "other-files" }, { edge: "bottom" });
    expect(filePlacement(layout, "pane-1", "reuse")).toEqual({ paneId: "pane-1" });
    expect(filePlacement(layout, "pane-1", "reuse", ["files"])).toEqual({ paneId: "pane-2" });
  });
  it("uses a standalone preview as the origin instead of the focused chat", () => {
    const layout = addDockView(createDockLayout([chat]), files, { edge: "right" });
    const focused = { ...layout, focusedPaneId: "main" };
    const source = { sourceViewId: "files" };
    expect(previewPlacement(focused, source, "reuse")).toEqual({ paneId: "pane-1" });
    expect(previewPlacement(focused, source, "same")).toEqual({ paneId: "pane-1" });
    expect(previewPlacement(focused, source, "beside")).toEqual({ paneId: "main" });
    expect(previewPlacement(focused, source, "split")).toEqual({
      paneId: "pane-1",
      edge: "right",
    });
    expect(previewPlacement(layout, { conversationId: "a" }, "same")).toEqual({ paneId: "main" });
  });
  it("does not mistake an isolated chat draft for a source conversation", () => {
    const layout = addDockView(
      createDockLayout([
        { id: "draft", kind: "conversation", title: "New chat", resource: { draftId: "d" } },
      ]),
      files,
      { edge: "right" },
    );
    expect(previewPlacement(layout, {}, "same")).toEqual({ paneId: "pane-1" });
  });
});
