// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { describe, expect, it } from "vitest";
import { addDockView, createDockLayout } from "./dockLayout";
import { filePlacement } from "./filePlacement";

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
});
