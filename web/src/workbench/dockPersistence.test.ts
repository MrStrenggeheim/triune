// Modified for Triune.
import { describe, expect, it } from "vitest";
import {
  addDockView,
  closeDockView,
  createDockLayout,
  parseDockLayout,
  resizeDockSplit,
  type DockView,
} from "./dockLayout";
import { terminalLayoutGeometry } from "@/lib/terminalSplitLayout";
import {
  composeDockLayout,
  createDockPersistence,
  navigateDockConversation,
  parseDockPersistence,
  pinDockView,
  unpinDockView,
  applyDockLayout,
  updateDockConversationTitles,
} from "./dockPersistence";

const conversation = (id: string): DockView => ({
  id: `conversation:${id}`,
  kind: "conversation",
  title: id,
  resource: { conversationId: id },
});

describe("conversation title batches", () => {
  it("updates shared, saved and pinned occurrences without changing geometry or unrelated resources", () => {
    const original = addDockView(createDockLayout([conversation("A")]), conversation("B"), {
      edge: "right",
    });
    const pinned = pinDockView(createDockPersistence(original), "conversation:B");
    const unchanged = { conversationId: "C", layout: createDockLayout([conversation("C")]) };
    const state = { ...pinned, chats: [...pinned.chats, unchanged] };
    const titles = new Map([
      ["A", "Latest A"],
      ["B", "Latest B"],
      ["missing", "Ignore"],
    ]);
    const next = updateDockConversationTitles(state, titles);
    for (const layout of [
      next.shared,
      next.pins,
      next.pinFrame!,
      ...next.chats.map((chat) => chat.layout),
    ]) {
      for (const item of layout.views) {
        const id = item.resource.conversationId as string;
        expect(item.title).toBe(titles.get(id) ?? id);
      }
    }
    expect(composeDockLayout(next).tree).toBe(composeDockLayout(state).tree);
    expect(next.shared.panes).toBe(state.shared.panes);
    expect(next.pins.panes).toBe(state.pins.panes);
    expect(next.pinFrame!.tree).toBe(state.pinFrame!.tree);
    expect(next.chats.at(-1)).toBe(unchanged);
    expect(next.shared.views[0].resource).toBe(state.shared.views[0].resource);
    expect(next.activeConversationId).toBe(state.activeConversationId);
    expect(parseDockPersistence(JSON.stringify(next))).toEqual(next);
    expect(updateDockConversationTitles(next, titles)).toBe(next);
    expect(updateDockConversationTitles(next, new Map())).toBe(next);
  });
});

function rectangle(layout: ReturnType<typeof createDockLayout>, id: string) {
  const pane = layout.panes.find((item) => item.viewIds.includes(id))!;
  const { key: _key, ...rect } = terminalLayoutGeometry(layout.tree!).panes.find(
    (item) => item.key === pane.id,
  )!;
  return rect;
}

describe("pins preserve their layout geometry", () => {
  it.each(["left", "right", "top", "bottom"] as const)(
    "keeps a %s pin in its exact rectangle through navigation, resize and unpin",
    (edge) => {
      const original = resizeDockSplit(
        addDockView(createDockLayout([conversation("A")]), explorer, { edge }),
        [],
        0.65,
      );
      let state = pinDockView(createDockPersistence(original), explorer.id);
      expect(composeDockLayout(state)).toEqual(original);
      const reserved = rectangle(original, explorer.id);
      state = navigateDockConversation(state, "B");
      expect(rectangle(composeDockLayout(state), explorer.id)).toEqual(reserved);
      expect(
        composeDockLayout(state)
          .views.map((view) => view.id)
          .sort(),
      ).toEqual(["conversation:B", "explorer"]);
      const resized = resizeDockSplit(composeDockLayout(state), [], 0.4);
      state = applyDockLayout(state, resized);
      expect(composeDockLayout(state)).toEqual(resized);
      state = navigateDockConversation(state, "A");
      expect(rectangle(composeDockLayout(state), explorer.id)).toEqual(
        rectangle(resized, explorer.id),
      );
      const beforeUnpin = composeDockLayout(state);
      state = unpinDockView(state, explorer.id);
      expect(composeDockLayout(state)).toEqual(beforeUnpin);
      expect(state.pins.views).toEqual([]);
      expect(parseDockPersistence(JSON.stringify(state))).toEqual(state);
    },
  );

  it("retains nested pins and valid empty drop slots when another chat has fewer panes", () => {
    let original = addDockView(createDockLayout([conversation("A")]), explorer, { edge: "right" });
    original = addDockView(
      original,
      { ...explorer, id: "lower" },
      { paneId: "main", edge: "bottom" },
    );
    let state = createDockPersistence(original);
    state = pinDockView(pinDockView(state, "explorer"), "lower");
    expect(composeDockLayout(state)).toEqual(original);
    state = navigateDockConversation(state, "B");
    const b = composeDockLayout(state);
    expect(parseDockLayout(b)).toEqual(b);
    for (const id of ["explorer", "lower"])
      expect(rectangle(b, id)).toEqual(rectangle(original, id));
    expect(b.views.some((view) => view.id === "conversation:A")).toBe(false);
    const restored = parseDockPersistence(JSON.stringify(state))!;
    expect(composeDockLayout(restored)).toEqual(b);
  });

  it("preserves a pinned tab in its existing group instead of inventing a second pane", () => {
    const original = createDockLayout([conversation("A"), explorer]);
    let state = pinDockView(createDockPersistence(original), "explorer");
    expect(composeDockLayout(state)).toEqual(original);
    state = navigateDockConversation(state, "B");
    const b = composeDockLayout(state);
    expect(b.panes).toHaveLength(1);
    expect(b.panes[0].viewIds).toEqual(["conversation:B", "explorer"]);
    state = applyDockLayout(state, closeDockView(b, "explorer"));
    expect(composeDockLayout(state).views.map((view) => view.id)).toEqual(["conversation:B"]);
    expect(state.pins.views).toEqual([]);
  });
});
const explorer: DockView = {
  id: "explorer",
  kind: "explorer",
  title: "Explorer",
  resource: { path: "/original", hostId: "host-a" },
};

describe("automatic conversation layout migration", () => {
  it.each([null, "A"])(
    "migrates the legacy shared arrangement for owner %s without losing saved B or pins",
    (activeConversationId) => {
      const shared = resizeDockSplit(
        addDockView(createDockLayout([conversation("A")]), explorer, { edge: "right" }),
        [],
        0.65,
      );
      const b = createDockLayout([conversation("B")]);
      const pins = createDockLayout([{ ...explorer, id: "pinned" }]);
      const legacy = {
        ...createDockPersistence(),
        automaticChatLayouts: undefined,
        shared,
        chats: [{ conversationId: "B", layout: b }],
        pins,
        activeConversationId,
      };
      const migrated = parseDockPersistence(JSON.stringify(legacy))!;
      expect(migrated.activeConversationId).toBe("A");
      expect(migrated.chats.find((chat) => chat.conversationId === "A")?.layout).toEqual(shared);
      expect(migrated.chats.find((chat) => chat.conversationId === "B")?.layout).toEqual(b);
      expect(migrated.pins).toEqual(pins);
      expect(migrated.shared).toEqual(shared);
      expect(parseDockPersistence(JSON.stringify(migrated))).toEqual(migrated);
      expect(
        composeDockLayout(navigateDockConversation(migrated, "B")).views.map((view) => view.id),
      ).toEqual(["conversation:B", "pinned"]);
    },
  );

  it("keeps an explicitly saved active arrangement and also preserves an unsaved shared owner", () => {
    const shared = createDockLayout([conversation("A"), explorer]);
    const b = createDockLayout([conversation("B")]);
    const legacy = {
      ...createDockPersistence(),
      automaticChatLayouts: undefined,
      shared,
      chats: [{ conversationId: "B", layout: b }],
      activeConversationId: "B",
    };
    const migrated = parseDockPersistence(JSON.stringify(legacy))!;
    expect(migrated.activeConversationId).toBe("B");
    expect(composeDockLayout(migrated)).toEqual(b);
    expect(composeDockLayout(navigateDockConversation(migrated, "A"))).toEqual(shared);
  });

  it("never replaces an explicit owner snapshot with a legacy shared arrangement", () => {
    const shared = createDockLayout([conversation("A"), explorer]);
    const saved = createDockLayout([conversation("A")]);
    const legacy = {
      ...createDockPersistence(),
      automaticChatLayouts: undefined,
      shared,
      chats: [{ conversationId: "A", layout: saved }],
      activeConversationId: "A",
    };
    const migrated = parseDockPersistence(JSON.stringify(legacy))!;
    expect(composeDockLayout(migrated)).toEqual(saved);
    expect(migrated.shared).toEqual(shared);
  });
});
