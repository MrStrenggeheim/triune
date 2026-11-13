// Modified for Triune.
import type { SessionWorkspaceState } from "@/lib/sessionWorkspaceState";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import type { DockView } from "./dockLayout";

/** Copy existing references only. Importing presentation must never launch or stop a resource. */
export function legacyWorkspaceViews(
  conversationId: string,
  state: SessionWorkspaceState,
  workspace?: WorkbenchWorkspace,
  workspaceState: SessionWorkspaceState = {},
): DockView[] {
  const resource = workspace
    ? { workspace, conversationId }
    : { conversationId, legacySessionResource: true };
  const views: DockView[] = [];
  const append = (
    suffix: string,
    kind: string,
    title: string,
    extra: Record<string, unknown> = {},
  ) =>
    views.push({
      id: `migrated:${conversationId}:${suffix}`,
      kind,
      title,
      resource: { ...resource, ...extra },
    });
  for (const child of state.openSideChats ?? []) {
    if (!child.startsWith("pending:"))
      views.push({
        id: `conversation:${child}`,
        kind: "conversation",
        title: "Subchat",
        resource: { conversationId: child },
      });
  }
  if ((workspaceState.open ?? state.open) === false) return views;
  const panels = new Set([
    ...(state.openPanels ?? []),
    ...(state.rightRailTab ? [state.rightRailTab] : []),
  ]);
  for (const panel of panels) {
    const kinds: Record<string, string> = {
      files: "files",
      changes: "changes",
      github: "pr",
      subagents: "activity",
      "content-search": "search",
    };
    const kind = kinds[panel];
    const labels: Record<string, string> = {
      files: "Explorer",
      changes: "Changes",
      pr: "Pull requests",
      activity: "Orchestration",
      search: "Search",
    };
    if (kind) append(panel, kind, labels[kind] ?? kind);
  }
  const appendOwnedResources = (saved: SessionWorkspaceState, captured?: WorkbenchWorkspace) => {
    const authority = captured
      ? { workspace: captured, conversationId }
      : { conversationId, legacySessionResource: true };
    const namespace = captured ? `workspace:${captured.id}` : `session:${conversationId}`;
    for (const path of saved.openFiles ?? [])
      views.push({
        id: `migrated:${namespace}:file:${path}`,
        kind: "preview",
        title: path.split("/").at(-1) || path,
        resource: { ...authority, path },
      });
    for (const key of saved.openTerminals ?? []) {
      if (!key.startsWith("terminal:")) continue;
      views.push({
        id: `migrated:${namespace}:${key}`,
        kind: "terminal",
        title: "Shell",
        resource: {
          ...authority,
          terminalId: key.slice("terminal:".length),
          terminalOwner: captured ? "workspace" : "conversation",
        },
      });
    }
  };
  appendOwnedResources(state);
  if (workspace) appendOwnedResources(workspaceState, workspace);
  return views;
}
