// Modified for Triune.
import { expect, it } from "vitest";
import {
  branchRoots,
  branchDescendantCounts,
  branchSectionAssignments,
  branchSource,
  visibleBranchRows,
  type BranchConversation,
} from "./conversationBranches";
import { conversation } from "@/test/sidebarMockHelpers";

function branch(id: string, parent?: string): BranchConversation {
  return {
    ...conversation(id),
    branch: parent
      ? { source_conversation_id: parent, reference_only: true, recovery: "replay" }
      : null,
  };
}
it("walks four levels in visible order and retains unreachable ancestors as orphans", () => {
  const rows = [
    branch("root"),
    branch("one", "root"),
    branch("two", "one"),
    branch("three", "two"),
    branch("four", "three"),
    branch("orphan", "private"),
  ];
  expect(branchRoots(rows).map((row) => row.id)).toEqual(["root", "orphan"]);
  expect(
    visibleBranchRows(rows, rows, new Set(["root", "one", "two", "three"])).map((row) => row.id),
  ).toEqual(["root", "one", "two", "three", "four", "orphan"]);
  expect(visibleBranchRows(rows, rows, new Set(["root", "three"])).map((row) => row.id)).toEqual([
    "root",
    "one",
    "orphan",
  ]);
});
it("uses explicit branch provenance, never delegation labels or titles, and bounds cycles", () => {
  const row = {
    ...branch("child", "branch-source"),
    parent_session_id: "delegator",
    title: "Side chat",
  };
  expect(branchSource(row)).toBe("branch-source");
  const withoutBranch: BranchConversation = { ...row, branch: null };
  expect(branchSource(withoutBranch)).toBeUndefined();
  const cycle = [branch("a", "b"), branch("b", "a")];
  expect(visibleBranchRows(cycle, cycle, new Set(["a", "b"])).map((item) => item.id)).toEqual([
    "a",
    "b",
  ]);
});

it("counts all unique descendants, including collapsed grandchildren, and excludes each parent", () => {
  const rows = [
    branch("root"),
    branch("a", "root"),
    branch("b", "root"),
    branch("c", "a"),
    branch("d", "a"),
    branch("e", "b"),
    branch("e", "b"),
  ];
  expect(Object.fromEntries(branchDescendantCounts(rows))).toEqual({
    root: 5,
    a: 2,
    b: 1,
    c: 0,
    d: 0,
    e: 0,
  });
  // Filtering removes edges as well as rows; inaccessible ancestors are never reconstructed.
  expect(Object.fromEntries(branchDescendantCounts(rows.filter((row) => row.id !== "a")))).toEqual({
    root: 2,
    b: 1,
    c: 0,
    d: 0,
    e: 0,
  });
});

it("bounds cycles, self-links and duplicates without dropping attached descendant trees", () => {
  const rows = [
    branch("a", "b"),
    branch("b", "a"),
    branch("c", "a"),
    branch("d", "c"),
    branch("self", "self"),
    branch("a", "b"),
  ];
  expect(Object.fromEntries(branchDescendantCounts(rows))).toEqual({
    a: 3,
    b: 3,
    c: 1,
    d: 0,
    self: 0,
  });
});

it("counts deep graphs without recursive stack limits", () => {
  const rows = Array.from({ length: 10000 }, (_, index) =>
    branch(String(index), index ? String(index - 1) : undefined),
  );
  const counts = branchDescendantCounts(rows);
  expect(counts.get("0")).toBe(9999);
  expect(counts.get("9999")).toBe(0);
  const sections = branchSectionAssignments(rows, new Map([["0", "project:alpha"]]));
  expect(sections.get("9999")).toBe("project:alpha");
});

it("inherits presentation through a project parent without changing child membership", () => {
  const rows = [
    { ...branch("root"), project_id: "alpha" },
    branch("child", "root"),
    branch("grandchild", "child"),
    branch("orphan", "inaccessible"),
  ];
  const before = structuredClone(rows);
  const sections = branchSectionAssignments(rows, new Map([["root", "project:alpha"]]));
  expect(Object.fromEntries(sections)).toEqual({
    root: "project:alpha",
    child: "project:alpha",
    grandchild: "project:alpha",
  });
  const sessions = rows.filter((row) => !sections.has(row.id));
  expect(branchRoots(sessions).map((row) => row.id)).toEqual(["orphan"]);
  expect(visibleBranchRows([rows[0]], rows, new Set(["root", "child"]), sections)).toEqual(
    rows.slice(0, 3),
  );
  expect(rows).toEqual(before);
});

it.each(["pinned", "project:beta"])(
  "keeps an explicit %s child and its descendants out of the parent's section",
  (destination) => {
    const rows = [branch("root"), branch("child", "root"), branch("grandchild", "child")];
    const sections = branchSectionAssignments(
      rows,
      new Map([
        ["root", "project:alpha"],
        ["child", destination],
      ]),
    );
    expect(sections.get("grandchild")).toBe(destination);
    expect(visibleBranchRows([rows[0]], rows, new Set(["root", "child"]), sections)).toEqual([
      rows[0],
    ]);
    expect(visibleBranchRows(rows.slice(1), rows, new Set(["child"]), sections)).toEqual(
      rows.slice(1),
    );
    expect(Object.fromEntries(branchDescendantCounts(rows, sections))).toEqual({
      root: 0,
      child: 1,
      grandchild: 0,
    });
  },
);

it("retains orphans when filters remove their source and bounds cycles in section assignment", () => {
  const child = branch("child", "filtered-parent");
  const cycle = [branch("a", "b"), branch("b", "a"), branch("c", "a")];
  const rows = [child, ...cycle];
  expect(branchSectionAssignments(rows, new Map()).size).toBe(0);
  expect(visibleBranchRows([child], rows, new Set())).toEqual([child]);
  expect(
    Object.fromEntries(branchSectionAssignments(rows, new Map([["b", "project:alpha"]]))),
  ).toEqual({ b: "project:alpha", a: "project:alpha", c: "project:alpha" });
});
