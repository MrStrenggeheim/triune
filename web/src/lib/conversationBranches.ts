// Modified for Triune.
import type { Conversation } from "@/hooks/useConversations";

export interface ConversationBranch {
  source_conversation_id: string;
  root_conversation_id?: string | null;
  source_item_id?: string | null;
  source_response_id?: string | null;
  inherited_item_count?: number | null;
  inherited_last_item_id?: string | null;
  created_at?: number | null;
  reference_only: boolean;
  recovery: "replay" | "legacy_unknown" | "unavailable";
}
export type BranchConversation = Conversation & { branch?: ConversationBranch | null };

/** Branch provenance is independent of delegation parent/root fields. */
export function branchSource(row: Conversation): string | undefined {
  const source = (row as BranchConversation).branch?.source_conversation_id;
  return typeof source === "string" && source && source !== row.id ? source : undefined;
}

/** Inherit presentation only; explicit pins/projects never change saved membership. */
export function branchSectionAssignments(
  rows: readonly Conversation[],
  explicitSections: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const sections = new Map(explicitSections);
  const resolved = new Set(sections.keys());
  for (const row of rows) {
    const path = new Set<string>();
    let ancestor: Conversation | undefined = row;
    while (ancestor && !resolved.has(ancestor.id) && !path.has(ancestor.id)) {
      path.add(ancestor.id);
      ancestor = byId.get(branchSource(ancestor) ?? "");
    }
    const section = ancestor ? sections.get(ancestor.id) : undefined;
    for (const id of path) {
      resolved.add(id);
      if (section !== undefined) sections.set(id, section);
    }
  }
  return sections;
}

function sectionBranchSource(
  row: Conversation,
  sections?: ReadonlyMap<string, string>,
): string | undefined {
  const source = branchSource(row);
  return source && (!sections || sections.get(row.id) === sections.get(source))
    ? source
    : undefined;
}

/** Keep an orphan visible; never invent an inaccessible ancestor's row or title. */
export function branchRoots(
  rows: readonly Conversation[],
  sections?: ReadonlyMap<string, string>,
): Conversation[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.filter((row) => {
    const source = sectionBranchSource(row, sections);
    if (!source || !byId.has(source)) return true;
    const seen = new Set([row.id]);
    let ancestor: Conversation | undefined = byId.get(source);
    while (ancestor) {
      if (seen.has(ancestor.id)) return true;
      seen.add(ancestor.id);
      ancestor = byId.get(sectionBranchSource(ancestor, sections) ?? "");
    }
    return false;
  });
}
export function branchChildren(
  rows: readonly Conversation[],
  parentId: string,
  sections?: ReadonlyMap<string, string>,
): Conversation[] {
  return rows.filter((row) => sectionBranchSource(row, sections) === parentId);
}

/** Count unique descendants in an authorized, filtered graph, excluding each parent. */
export function branchDescendantCounts(
  rows: readonly Conversation[],
  sections?: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const counts = new Map([...byId.keys()].map((id) => [id, 0]));
  const remainingChildren = new Map(counts);
  for (const row of byId.values()) {
    const parent = sectionBranchSource(row, sections);
    if (parent && byId.has(parent))
      remainingChildren.set(parent, remainingChildren.get(parent)! + 1);
  }
  // Fold leaves into parents without recursion, including arbitrarily deep chains.
  const ready = [...byId.keys()].filter((id) => remainingChildren.get(id) === 0);
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    const parent = sectionBranchSource(byId.get(id)!, sections);
    if (!parent || !byId.has(parent)) continue;
    counts.set(parent, counts.get(parent)! + counts.get(id)! + 1);
    const remaining = remainingChildren.get(parent)! - 1;
    remainingChildren.set(parent, remaining);
    if (remaining === 0) ready.push(parent);
  }
  // Every remaining component is a cycle with its attached trees already folded in.
  const visited = new Set<string>();
  for (const start of byId.keys()) {
    if (!remainingChildren.get(start) || visited.has(start)) continue;
    const cycle: string[] = [];
    let id = start;
    while (!visited.has(id)) {
      visited.add(id);
      cycle.push(id);
      id = sectionBranchSource(byId.get(id)!, sections)!;
    }
    const total = cycle.reduce((sum, member) => sum + counts.get(member)! + 1, 0);
    for (const member of cycle) counts.set(member, total - 1);
  }
  return counts;
}
export function visibleBranchRows(
  roots: readonly Conversation[],
  rows: readonly Conversation[],
  expanded: ReadonlySet<string>,
  sections?: ReadonlyMap<string, string>,
): Conversation[] {
  const result: Conversation[] = [];
  const visited = new Set<string>();
  function visit(row: Conversation) {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    result.push(row);
    if (expanded.has(row.id))
      for (const child of branchChildren(rows, row.id, sections)) visit(child);
  }
  for (const row of branchRoots(roots, sections)) visit(row);
  return result;
}
