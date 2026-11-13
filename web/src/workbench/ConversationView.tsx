// Modified for Triune.
import { memo, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ChevronRightIcon, ShareIcon, InfoIcon, GitForkIcon, SquareIcon } from "lucide-react";
import { ScopedConversationSurface } from "./ScopedConversationSurface";
import { ScopedConversationTerminal } from "./ScopedConversationTerminal";
import { ViewModeToggle } from "@/shell/ViewModeToggle";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { AgentInfoContent } from "@/components/AgentInfo";
import { PermissionsModal } from "@/components/PermissionsModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TooltipButton } from "@/components/ui/tooltip";
import { useSession } from "@/hooks/useSession";
import { useSessionAgent } from "@/hooks/useAgents";
import { useSessionActionRestrictions } from "@/hooks/useSessionActionRestrictions";
import { useRunnerHealthRegistration } from "@/hooks/RunnerHealthProvider";
import type { Conversation } from "@/hooks/useConversations";
import { useCanEdit } from "@/hooks/usePermissions";
import { useBrowserAgentRelay } from "@/hooks/useBrowserAgentRelay";
import { useUiOpenFile } from "@/hooks/useUiOpenFile";
import { useWorkspaceResources } from "@/shell/useWorkspaceResources";
import { FileViewerContext } from "@/shell/FileViewerContext";
import { isOwnerLevel, workspaceSharingBlocked } from "@/lib/permissionsApi";
import { HeaderConversationMenu } from "@/shell/HeaderConversationMenu";
import { ForkDialogContextProvider } from "@/shell/ForkDialogContext";
import { ForkSessionDialog } from "@/shell/ForkSessionDialog";
import { ContextSearchBar } from "@/shell/ContextSearchBar";
import { useContextSearch } from "@/shell/ContextSearchContext";
import { useWorkbench, useWorkbenchActions } from "./WorkbenchContext";
import { ScopedChatStoreProvider, useConversationChatStore } from "./ScopedChatStore";
import { useViewCommands } from "./viewCommands";
import type { ActionCommand } from "@/shell/contextSearch/actions";
import type { Session } from "@/lib/types";

export function conversationBranchSource(
  session: Pick<Session, "branch" | "labels" | "parentSessionId">,
): string | null {
  return (
    session.branch?.source_conversation_id ??
    session.labels?.["omnigent.branch.source_conversation_id"] ??
    session.labels?.["omnigent.side_chat.source_id"] ??
    session.labels?.["omnigent.fork.source_id"] ??
    session.parentSessionId ??
    null
  );
}

function Ancestor({ id, seen }: { id: string; seen: string[] }) {
  const { session } = useSession(id);
  const workbench = useWorkbenchActions();
  if (!session || seen.includes(id) || seen.length >= 16) return null;
  const parent = conversationBranchSource(session);
  return (
    <>
      {parent && <Ancestor id={parent} seen={[...seen, id]} />}
      <TooltipButton
        className="min-w-0 max-w-32 truncate text-muted-foreground hover:text-foreground"
        onClick={() => workbench?.openConversation(id)}
        tooltip={session.title || "Conversation"}
      >
        {session.title || "Conversation"}
      </TooltipButton>
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
    </>
  );
}

const ConversationSurface = memo(ScopedConversationSurface);

function ConversationSearchBar({ conversationId }: { conversationId: string }) {
  const search = useContextSearch();
  return search?.open && search.activeSessionId === conversationId ? (
    <ContextSearchBar contained />
  ) : null;
}

export const ConversationView = memo(function ConversationView({
  conversationId,
  visible = true,
  focused,
  children,
}: {
  conversationId: string;
  visible?: boolean;
  focused?: boolean;
  children?: ReactNode;
}) {
  const workbench = useWorkbench();
  const isFocused = visible && (focused ?? workbench?.focusedConversationId === conversationId);
  return (
    <ScopedChatStoreProvider
      key={conversationId}
      conversationId={conversationId}
      visible={visible}
      focused={isFocused}
    >
      <ScopedConversationTerminal key={conversationId} conversationId={conversationId}>
        <ConversationViewContent
          conversationId={conversationId}
          visible={visible}
          focused={isFocused}
        >
          {children}
        </ConversationViewContent>
      </ScopedConversationTerminal>
    </ScopedChatStoreProvider>
  );
});

const ConversationViewContent = memo(function ConversationViewContent({
  conversationId,
  visible,
  focused,
  children,
}: {
  conversationId: string;
  visible: boolean;
  focused: boolean;
  children?: ReactNode;
}) {
  const useChatStore = useConversationChatStore();
  const { session, error } = useSession(conversationId);
  const { data: agent } = useSessionAgent(conversationId);
  const canEdit = useCanEdit(conversationId);
  const fileContext = useContext(FileViewerContext);
  const resources = useWorkspaceResources({
    sessionId: conversationId,
    permissionLevel: session?.permissionLevel ?? null,
    shareWorkspaceFiles: session?.shareWorkspaceFiles,
    workspace: null,
  });
  const openRequestedFile = useCallback(
    (path: string) => fileContext?.openFile(path),
    [fileContext],
  );
  useUiOpenFile(
    conversationId,
    resources.showFilesPanel && fileContext !== null,
    openRequestedFile,
  );
  useBrowserAgentRelay(canEdit ? conversationId : null, true);
  const restrictions = useSessionActionRestrictions(conversationId);
  const registrations = useMemo(() => [{ id: conversationId }], [conversationId]);
  useRunnerHealthRegistration(registrations);
  const [shareOpen, setShareOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [fork, setFork] = useState<{ upToResponseId?: string; workspaceRecovery?: boolean } | null>(
    null,
  );
  const parent = session ? conversationBranchSource(session) : null;
  const canShare = isOwnerLevel(session?.permissionLevel ?? null);
  const shareDisabled = workspaceSharingBlocked(session?.workspace);
  const openShare = useCallback(() => {
    if (canShare && !shareDisabled) setShareOpen(true);
  }, [canShare, shareDisabled]);
  const openInfo = useCallback(() => setInfoOpen(true), []);
  const hasSession = !!session;
  const openFork = useCallback(
    (options?: { upToResponseId?: string; workspaceRecovery?: boolean }) => {
      if (hasSession && !restrictions.forkDisabledReason) setFork(options ?? {});
    },
    [hasSession, restrictions.forkDisabledReason],
  );
  const forkContext = useMemo(
    () => ({
      currentSessionId: conversationId,
      canFork: hasSession,
      disabledReason: restrictions.forkDisabledReason,
      openForkDialog: openFork,
    }),
    [conversationId, hasSession, restrictions.forkDisabledReason, openFork],
  );
  const working = useChatStore(
    (state) =>
      state.status === "streaming" ||
      state.sessionStatus === "running" ||
      state.sessionStatus === "waiting",
  );
  const stop = useCallback(() => {
    if (canEdit) useChatStore.getState().stop();
  }, [canEdit, useChatStore]);
  const commands = useMemo<ActionCommand[]>(() => {
    if (!visible || !session) return [];
    const actions: ActionCommand[] = [
      {
        id: "conversation-info",
        label: "Conversation information",
        icon: InfoIcon,
        keywords: ["agent", "details"],
        run: openInfo,
      },
    ];
    if (canShare && !shareDisabled)
      actions.push({
        id: "conversation-share",
        label: "Share conversation",
        icon: ShareIcon,
        keywords: ["access", "permissions"],
        run: openShare,
      });
    if (!restrictions.forkDisabledReason)
      actions.push({
        id: "conversation-branch",
        label: "Branch conversation",
        icon: GitForkIcon,
        keywords: ["fork", "clone", "subchat"],
        run: () => openFork(),
      });
    if (canEdit && working)
      actions.push({
        id: "conversation-stop",
        label: "Stop conversation",
        icon: SquareIcon,
        keywords: ["interrupt", "cancel"],
        run: stop,
      });
    return actions;
  }, [
    visible,
    session,
    openInfo,
    canShare,
    shareDisabled,
    openShare,
    restrictions.forkDisabledReason,
    openFork,
    canEdit,
    working,
    stop,
  ]);
  useViewCommands(commands);
  const conversation: Conversation | null = session
    ? {
        id: session.id,
        object: "conversation",
        title: session.title,
        created_at: session.createdAt,
        updated_at: session.createdAt,
        labels: session.labels ?? {},
        permission_level: session.permissionLevel ?? null,
        workspace: session.workspace,
        host_id: session.hostId,
        agent_id: session.agentId,
        archived: session.archived,
        status:
          session.status === "waiting" || session.status === "launching"
            ? "running"
            : session.status,
      }
    : null;
  const header = (
    <div className="workspace-control-header flex items-center gap-1.5 border-b px-3">
      <nav
        aria-label="Conversation ancestry"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
      >
        {parent && <Ancestor id={parent} seen={[conversationId]} />}
        <span className="min-w-0 truncate">
          {session?.title || (error ? "Conversation unavailable" : "Conversation")}
        </span>
      </nav>
      <ViewModeToggle hotkeyEnabled={focused} alwaysVisible />
      {conversation && (
        <HeaderConversationMenu
          conversation={conversation}
          currentProject={session?.projectId ?? null}
          canShare={canShare}
          canFork={!!session}
          forkDisabledReason={restrictions.forkDisabledReason}
          shareDisabled={shareDisabled}
          shareDisabledReason="Workspace sharing is unavailable for this directory"
          onShare={openShare}
          onFork={() => openFork()}
          hasAgentInfo
          onAgentInfo={openInfo}
        />
      )}
    </div>
  );

  return (
    <ConversationScopeContext.Provider value={conversationId}>
      <ForkDialogContextProvider value={forkContext}>
        <section
          className="workbench-conversation relative flex h-full min-h-0 flex-col"
          data-context-search-region="chat"
          data-session-id={conversationId}
        >
          {header}
          <ConversationSearchBar conversationId={conversationId} />
          <div className="relative min-h-0 flex-1 overflow-hidden flex flex-col">
            {children ?? <ConversationSurface conversationId={conversationId} visible={visible} />}
          </div>
        </section>
        <PermissionsModal
          sessionId={conversationId}
          workspace={session?.workspace}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
        {session && fork && (
          <ForkSessionDialog
            sourceSessionId={conversationId}
            sourceTitle={session.title}
            sourceWorkspace={session.workspace}
            sourceHostId={session.hostId}
            sourceGitBranch={session.gitBranch}
            {...fork}
            open
            onOpenChange={(open) => {
              if (!open) setFork(null);
            }}
          />
        )}
        <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Conversation information</DialogTitle>
            </DialogHeader>
            <AgentInfoContent
              agent={agent}
              sessionId={conversationId}
              permissionLevel={session?.permissionLevel}
            />
          </DialogContent>
        </Dialog>
      </ForkDialogContextProvider>
    </ConversationScopeContext.Provider>
  );
});
