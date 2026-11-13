// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it, vi } from "vitest";
import { SnapshotBackfill } from "./snapshotBackfill";

it("bounds requests per pass, continues the previous cursor and retains exact item order", async () => {
  const reader = new SnapshotBackfill<{ id: string }>();
  const page = (ids: string[], hasMore = true) => ({ items: ids.map((id) => ({ id })), hasMore });
  const older = vi.fn(async (cursor: string) => {
    if (cursor === "9") return page(["7", "8"]);
    if (cursor === "7") return page(["5", "6"]);
    if (cursor === "5") return page(["3", "4"]);
    return page(["1", "2"], false);
  });
  const latest = page(["9", "10"]);
  const anchors = new Set(["1"]);
  const first = await reader.read(latest, anchors, older, () => true, 3);
  expect(first.complete).toBe(false);
  expect(older.mock.calls.map(([cursor]) => cursor)).toEqual(["9", "7"]);
  const second = await reader.read(page(["10", "11"]), anchors, older, () => true, 3);
  expect(second.complete).toBe(true);
  expect(older.mock.calls.map(([cursor]) => cursor)).toEqual(["9", "7", "5", "3"]);
  expect(second.items.map((item) => item.id)).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
  ]);
});

it("discards a stale pass without advancing its continuation", async () => {
  const reader = new SnapshotBackfill<{ id: string }>();
  let current = true;
  const readOlder = vi.fn(async () => {
    current = false;
    return { items: [{ id: "a" }], hasMore: false };
  });
  const result = await reader.read(
    { items: [{ id: "b" }], hasMore: true },
    new Set(["a"]),
    readOlder,
    () => current,
    2,
  );
  expect(result.complete).toBe(false);
  expect(result.items).toEqual([{ id: "b" }]);
});
