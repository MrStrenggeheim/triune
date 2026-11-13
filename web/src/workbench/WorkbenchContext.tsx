// Modified for Triune.
import type { ActivitySource } from "./ActivityView";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useStableCallback } from "@/hooks/useStableCallback";
import { useShallowStable } from "@/hooks/useShallowStable";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import type { OpenFileOptions } from "@/shell/FileViewerContext";

export type WorkbenchViewKind =
  | "conversation"
  | "files"
  | "preview"
  | "attachment-preview"
  | "changes"
  | "search"
  | "shells"
  | "terminal"
  | "agent-terminal"
  | "activity"
  | "automations"
  | "pr"
  | "browser"
  | "logs";

export interface OpenWorkbenchView {
  kind: WorkbenchViewKind;
  source?: ActivitySource;
  focusAgentId?: string;
  conversationId?: string;
  workspace?: WorkbenchWorkspace;
  workspaceId?: string;
  commentId?: string;
  initialDiff?: boolean;
  linkRequestId?: string;
  unavailableReason?: string;
  path?: string;
  terminalId?: string;
  title?: string;
  fileOptions?: OpenFileOptions;
  sourceViewId?: string;
  replaceOpen?: boolean;
  searchQuery?: string;
  terminalOwner?: "workspace" | "conversation";
  legacySessionResource?: boolean;
}

export interface WorkbenchActions {
  openConversation: (id: string, options?: { beside?: boolean; messageId?: string }) => void;
  openView: (request: OpenWorkbenchView, options?: { beside?: boolean }) => void;
  focusedConversationId?: string;
  openConversationIds?: readonly string[];
}

const WorkbenchContext = createContext<WorkbenchActions | null>(null);
type WorkbenchNavigationActions = Pick<WorkbenchActions, "openConversation" | "openView">;
const WorkbenchActionsContext = createContext<WorkbenchNavigationActions | null>(null);

export function WorkbenchProvider({
  value,
  children,
}: {
  value: WorkbenchActions;
  children: ReactNode;
}) {
  const openConversation = useStableCallback(value.openConversation);
  const openView = useStableCallback(value.openView);
  const actions = useMemo(() => ({ openConversation, openView }), [openConversation, openView]);
  const openConversationIds = useShallowStable(value.openConversationIds);
  const focusedConversationId = value.focusedConversationId;
  const selection = useMemo(
    () => ({ ...actions, focusedConversationId, openConversationIds }),
    [actions, focusedConversationId, openConversationIds],
  );
  return (
    <WorkbenchActionsContext.Provider value={actions}>
      <WorkbenchContext.Provider value={selection}>{children}</WorkbenchContext.Provider>
    </WorkbenchActionsContext.Provider>
  );
}

export function useWorkbench() {
  return useContext(WorkbenchContext);
}

/** Navigation consumers do not subscribe to focused/open conversation changes. */
export function useWorkbenchActions() {
  return useContext(WorkbenchActionsContext);
}
