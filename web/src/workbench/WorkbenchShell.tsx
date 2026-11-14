// Modified for Triune.
import { useSettingsNavigationVisibility } from "@/hooks/useSettingsNavigationVisibility";
import { useSettingsRoute } from "@/shell/settingsNav";
import { parseWorkbenchFileLink, resolveWorkbenchFileLink } from "./fileLinks";
import { WorkbenchBindings } from "./WorkbenchBindings";
import { createWorkbenchResourceShortcuts } from "./resourceShortcuts";
import { useAcceptedConversationRoute } from "./useAcceptedConversationRoute";
import { focusedResourceTarget } from "./resourceTarget";
import { OpenViewMenu } from "./OpenViewMenu";
import { Button } from "@/components/ui/button";
import { CapturedFileActions } from "./CapturedFileActions";
import { CapturedFileGate, capturedFileQuery } from "./CapturedFileGate";
import { fetchChatFileLocation } from "@/lib/chatFileReferences";
import { readFileOpening } from "@/lib/fileOpeningPreferences";
import { downloadBlob } from "@/lib/explorerOperations";
import { filePlacement } from "./filePlacement";
import { OverlayScrollbars } from "@/components/OverlayScrollbars";
import {
  AttachmentPreviewContext,
  AttachmentPreviewView,
  type AttachmentPreviewRequest,
  type AttachmentPreviewPlacement,
} from "@/components/ChatAttachment";
import { conversationPlacement } from "./viewPlacement";
import { joinBrowseLocation } from "@/lib/workspacePaths";
import { ConversationSourcePicker } from "./ConversationSourcePicker";
import { ImportReviewGate } from "@/components/onboarding/HostImportReview";
import { ArcaShutdownToast } from "@/components/ArcaShutdownToast";
import { useIsEmbedded } from "@/lib/embedded";
import { legacyWorkspaceViews } from "./legacyLayout";
import { dockStorageKey } from "./dockPersistence";
import { readSessionWorkspaceState } from "@/lib/sessionWorkspaceState";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Undo2Icon,
  PlusIcon,
  XIcon,
  WorkflowIcon,
  CalendarClockIcon,
  FolderIcon,
  GitCompareIcon,
  GitPullRequestIcon,
  GlobeIcon,
  ListIcon,
  MessageSquareIcon,
  SearchIcon,
  TerminalIcon,
  HatGlassesIcon,
} from "lucide-react";
import { Outlet, useLocation, useNavigate, useParams } from "@/lib/routing";
import { getOmnigentServerIdentity } from "@/lib/host";
import { useViewerId, useIdentityReady } from "@/hooks/useViewerId";
import { useContextSearchController } from "@/hooks/useContextSearchController";
import { useLoadedConversations } from "@/hooks/useSidebarData";
import { subagentName } from "@/lib/subagentActivity";
import { resolveChatWorkspace } from "@/hooks/useWorkbenchSelection";
import { createTerminal, findAgentTerminal, useTerminals } from "@/hooks/useTerminals";
import { useDebugMode } from "@/hooks/useDebugMode";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { isFeatureEnabled } from "@/lib/capabilities";
import {
  supportsBrowser,
  isIOSShell,
  isAndroidShell,
  type onNativeSidebarDrag,
} from "@/lib/nativeBridge";
import { toast } from "@/lib/notifications";
import { useChatStore } from "@/store/chatStore";
import { isTempConvId } from "@/lib/tempConversationId";
import { randomUUID } from "@/lib/randomUUID";
import { getFindContext } from "@/lib/findContext";
import { readPanelFolder, panelFolderKey, setPanelFolder, usePanelFolder } from "@/lib/panelFolder";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import { authenticatedFetch } from "@/lib/identity";
import { ApiError, apiErrorFromResponse, interrupt } from "@/lib/sessionsApi";
import { Sidebar, isMobileViewport } from "@/shell/Sidebar";
import { ContextSearchProvider } from "@/shell/ContextSearchContext";
import { CommandPalette } from "@/shell/CommandPalette";
import { searchActions, type ActionCommand } from "@/shell/contextSearch/actions";
import type { FileNavigationGuard, FilePosition, OpenFileOptions } from "@/shell/FileViewerContext";
import { NotificationLayoutProvider } from "@/components/NotificationCenter";
import { Toaster } from "@/components/ui/sonner";
import { BrowserPane } from "@/components/BrowserPane/BrowserPane";
import { ExecutionLogsPanel } from "@/shell/ExecutionLogsPanel";
import { TasksPage } from "@/pages/TasksPage";
import {
  WorkbenchProvider,
  type OpenWorkbenchView,
  type WorkbenchViewKind,
} from "./WorkbenchContext";
import { WorkbenchAppBar, type WorkbenchOpenAction } from "./WorkbenchAppBar";
import { ConversationView } from "./ConversationView";
import { ActivityView, type ActivitySource } from "./ActivityView";
import { TerminalResourceView, RetainedActivityView } from "./TerminalResourceView";
import { ShellResourceView } from "./ShellResourceView";
import { ResourceView, inheritResourceViewState } from "./ResourceView";
import { DockWorkspace, type DockViewVisibility } from "./DockWorkspace";
import { canSuspendDockView } from "./viewLifetime";
import { useDockLayout } from "./useDockLayout";
import {
  sameDockResource,
  dockPaneForView,
  moveDockView,
  createDockLayout,
  type DockView,
  type DockPlacement,
} from "./dockLayout";
import { OpenLocationDialog } from "./OpenLocationDialog";
import "./workbenchShell.css";
import "./workbenchSurfaces.css";
import {
  ContextReferenceNavigationContext,
  createQuoteSubchat,
} from "@/lib/contextReferenceNavigation";
import { ViewCommandScope, useFocusedViewCommands } from "./viewCommands";

const VIEW_TYPES: { kind: WorkbenchViewKind; label: string; icon: typeof FolderIcon }[] = [
  { kind: "files", label: "Explorer", icon: FolderIcon },
  { kind: "changes", label: "Changes", icon: GitCompareIcon },
  { kind: "search", label: "Search and replace", icon: SearchIcon },
  { kind: "terminal", label: "Manual terminal", icon: TerminalIcon },
  { kind: "agent-terminal", label: "Agent CLI", icon: HatGlassesIcon },
  { kind: "activity", label: "Orchestration", icon: WorkflowIcon },
  { kind: "pr", label: "Pull requests", icon: GitPullRequestIcon },
  { kind: "automations", label: "Automations", icon: CalendarClockIcon },
  { kind: "browser", label: "Browser", icon: GlobeIcon },
  { kind: "logs", label: "Logs", icon: ListIcon },
];

const VIEW_COMMAND_TERMS: Record<string, string[]> = {
  "open-files": [
    "upload",
    "download",
    "create file",
    "new folder",
    "rename",
    "move",
    "trash",
    "delete file",
    "preview",
    "comments",
  ],
  "open-changes": ["git", "diff", "compare", "commit", "revisions", "agent changes"],
  "open-pr": ["github", "gitlab", "azure", "pull request", "merge request", "review"],
  "open-activity": ["agents", "subagents", "peer messages", "results", "shell history"],
  "open-automations": ["schedule", "cron", "runs", "definitions"],
};

function conversationView(id: string, title = "Conversation"): DockView {
  return {
    id: `conversation:${id}`,
    kind: "conversation",
    title,
    resource: { conversationId: id },
  };
}

function viewWorkspace(view?: DockView): WorkbenchWorkspace | undefined {
  const value = view?.resource.workspace;
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("root" in value) ||
    typeof value.root !== "string"
  )
    return undefined;
  return value as WorkbenchWorkspace;
}

function activitySource(
  resource: Record<string, unknown>,
  workspace?: WorkbenchWorkspace,
  conversationId?: string,
  legacyShells = false,
): ActivitySource | undefined {
  const value = resource.source;
  if (value && typeof value === "object") {
    if (
      "kind" in value &&
      value.kind === "chat" &&
      "conversationId" in value &&
      typeof value.conversationId === "string"
    )
      return { kind: "chat", conversationId: value.conversationId };
    if (
      "kind" in value &&
      value.kind === "host" &&
      "hostId" in value &&
      typeof value.hostId === "string"
    )
      return {
        kind: "host",
        hostId: value.hostId,
        ...(workspace?.host_id === value.hostId ? { workspace } : {}),
      };
  }
  if (legacyShells && workspace?.host_id)
    return { kind: "host", hostId: workspace.host_id, workspace };
  return conversationId
    ? { kind: "chat", conversationId }
    : workspace?.host_id
      ? { kind: "host", hostId: workspace.host_id, workspace }
      : undefined;
}

export function WorkbenchShell({ active = true }: { active?: boolean }) {
  const viewer = useViewerId();
  const ready = useIdentityReady();
  if (!ready)
    return (
      <div role="status" className="p-4 text-sm">
        Loading workspace…
      </div>
    );
  return (
    <WorkbenchShellBody
      key={`${getOmnigentServerIdentity()}:${viewer}`}
      accountId={viewer ?? "anonymous"}
      active={active}
    />
  );
}

function WorkbenchShellBody({ accountId, active }: { accountId: string; active: boolean }) {
  const { conversationId: routeConversationId } = useParams<{ conversationId: string }>();
  const conversationId = isTempConvId(routeConversationId) ? undefined : routeConversationId;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobileViewport());
  const { inSettings } = useSettingsRoute();
  useSettingsNavigationVisibility({ inSettings, sidebarOpen, setSidebarOpen, enabled: active });
  const [sidebarDragProgress, setSidebarDragProgress] = useState<number | null>(null);
  const handleSidebarDrag = useCallback<Parameters<typeof onNativeSidebarDrag>[0]>(
    (phase, progress) => {
      if (phase === "open" || phase === "close") {
        setSidebarDragProgress(null);
        setSidebarOpen(phase === "open");
      } else if (isMobileViewport()) setSidebarDragProgress(progress);
    },
    [],
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sessionsOnly, setSessionsOnly] = useState(false);
  const [closedViews, setClosedViews] = useState<DockView[]>([]);
  const [locationRequest, setLocationRequest] = useState<OpenWorkbenchView | null>(null);
  const guards = useRef(new Map<string, Set<FileNavigationGuard>>());
  const explicitSearchViews = useRef(new Set<string>());
  const [lastConversation, setLastConversation] = useState(conversationId);
  const closeGuard = useCallback(async (view: DockView) => {
    for (const guard of guards.current.get(view.id) ?? []) {
      // Dirty-file decisions run sequentially so dialogs never overlap.
      // eslint-disable-next-line no-await-in-loop
      const allowed = await new Promise<boolean>((resolve) => {
        guard(
          "",
          undefined,
          () => resolve(true),
          () => resolve(false),
        );
      });
      if (!allowed) return false;
    }
    return true;
  }, []);
  const canSuspendView = useCallback((view: DockView) => {
    if (!canSuspendDockView(view) || guards.current.get(view.id)?.size) return false;
    const surface = [...document.querySelectorAll<HTMLElement>("[data-workbench-view]")].find(
      (element) => element.dataset.workbenchView === view.id,
    );
    return !surface?.querySelector('[data-view-retain="true"]');
  }, []);
  const scope = {
    accountId,
    serverId: getOmnigentServerIdentity() || window.location.origin,
    clientId: "browser",
  };
  const [migrationSource] = useState(() => {
    try {
      return !localStorage.getItem(dockStorageKey(scope)) ? conversationId : undefined;
    } catch {
      return undefined;
    }
  });
  const dock = useDockLayout({
    scope,
    initialLayout: createDockLayout(conversationId ? [conversationView(conversationId)] : []),
    onBeforeClose: closeGuard,
  });
  const dockRef = useRef(dock);
  dockRef.current = dock;
  const attachmentOpenGeneration = useRef(0);
  const attachmentOpenScope = useRef({ key: dock.scopeKey, owner: dock.activeConversationId });
  if (
    attachmentOpenScope.current.key !== dock.scopeKey ||
    attachmentOpenScope.current.owner !== dock.activeConversationId
  ) {
    attachmentOpenScope.current = { key: dock.scopeKey, owner: dock.activeConversationId };
    attachmentOpenGeneration.current++;
  }

  const focusedPane = dock.layout.panes.find((pane) => pane.id === dock.layout.focusedPaneId);
  const focusedView = dock.layout.views.find((view) => view.id === focusedPane?.selectedViewId);
  const focusedConversationId =
    focusedView?.kind === "conversation" && typeof focusedView.resource.conversationId === "string"
      ? focusedView.resource.conversationId
      : lastConversation;
  const {
    workspace: selectedWorkspace,
    conversationId: resourceConversationId,
    folderOwner,
  } = focusedResourceTarget(focusedView);
  const selectedFolder = usePanelFolder(
    folderOwner,
    selectedWorkspace?.root ?? null,
    focusedView?.id,
  );
  const paletteFileTarget = useMemo(
    () =>
      selectedWorkspace || resourceConversationId
        ? {
            workspace: selectedWorkspace,
            conversationId: resourceConversationId,
            folder: selectedFolder,
          }
        : undefined,
    [selectedWorkspace, resourceConversationId, selectedFolder],
  );
  const embedded = useIsEmbedded();
  const focusedCommands = useFocusedViewCommands(focusedView?.id);
  const { data: conversations } = useLoadedConversations();
  const loadedConversations = useMemo(
    () => conversations?.pages.flatMap((page) => page.data) ?? [],
    [conversations],
  );
  const titles = useMemo(
    () =>
      new Map(
        conversations?.pages.flatMap((page) =>
          page.data.map((row) => [row.id, row.title || "Conversation"] as const),
        ),
      ),
    [conversations],
  );
  const titlesRef = useRef(titles);
  titlesRef.current = titles;
  useEffect(() => {
    for (const view of dock.retainedViews) {
      if (view.kind !== "conversation" || typeof view.resource.conversationId !== "string")
        continue;
      const title = titles.get(view.resource.conversationId);
      if (title && title !== view.title)
        void dockRef.current
          .updateView(view.id, { title })
          .catch((error) =>
            toast.error(error instanceof Error ? error.message : "Could not update chat title"),
          );
    }
  }, [dock.retainedViews, titles]);
  const lastConversationRef = useRef(lastConversation);
  lastConversationRef.current = lastConversation;

  useEffect(() => {
    for (const view of dock.retainedViews) {
      if (view.kind === "shells") {
        const workspace = viewWorkspace(view);
        const source = activitySource(
          view.resource,
          workspace,
          typeof view.resource.conversationId === "string"
            ? view.resource.conversationId
            : undefined,
          true,
        );
        void dock.updateView(view.id, {
          kind: "activity",
          title: "Orchestration",
          resource: JSON.parse(JSON.stringify({ ...view.resource, source })) as Record<
            string,
            unknown
          >,
        });
      } else if (view.kind === "activity" && view.title === "Activity") {
        void dock.updateView(view.id, { title: "Orchestration" });
      } else if (view.kind === "agent-terminal" && view.title === "Agent terminal") {
        void dock.updateView(view.id, { title: "Agent CLI" });
      }
    }
  }, [dock]);
  const showDock =
    active &&
    (!!conversationId || new URLSearchParams(location.search).get("view") === "workbench");
  const showDockRef = useRef(showDock);
  showDockRef.current = showDock;
  const activeRef = useRef(active);
  activeRef.current = active;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!migrationSource) return;
    const migrationScope = dockRef.current.scopeKey;
    let cancelled = false;
    const migrate = async () => {
      let workspace: WorkbenchWorkspace | undefined;
      try {
        workspace = await resolveChatWorkspace(migrationSource);
      } catch (error) {
        if (!(error instanceof ApiError && [403, 404, 405, 501].includes(error.status)))
          throw error;
      }
      if (cancelled || dockRef.current.scopeKey !== migrationScope) return;
      const sessionState = readSessionWorkspaceState(migrationSource);
      const workspaceState = workspace
        ? readSessionWorkspaceState(`workbench:${workspace.id}`)
        : {};
      const migrated = legacyWorkspaceViews(
        migrationSource,
        sessionState,
        workspace,
        workspaceState,
      );
      if (!migrated.length) return;
      dockRef.current.restoreConversationViews(migrationSource, migrated, { edge: "right" });
    };
    void migrate().catch((error) => {
      if (!cancelled)
        toast.error(
          `Could not restore previous views: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
    return () => {
      cancelled = true;
    };
  }, [migrationSource]);
  const skipLayoutForRoute = useRef<string | null>(null);
  const routeConversationRef = useRef(conversationId);
  routeConversationRef.current = conversationId;
  const openConversation = useCallback(
    (id: string, options?: { beside?: boolean; messageId?: string; title?: string }) => {
      const current = dockRef.current;
      if (options?.beside) {
        current.addView(conversationView(id, options?.title ?? titlesRef.current.get(id)), {
          paneId: current.layout.focusedPaneId ?? undefined,
          edge: "right",
        });
        setLastConversation(id);
        return;
      }
      if (id === routeConversationRef.current && !options?.messageId) {
        const capturedScopeKey = current.scopeKey;
        void current
          .navigateConversation(id)
          .then((allowed) => {
            if (!allowed) return;
            const latest = dockRef.current;
            if (latest.scopeKey !== capturedScopeKey || latest.activeConversationId !== id) return;
            const view = conversationView(id, titlesRef.current.get(id));
            if (latest.layout.views.some((item) => item.id === view.id)) latest.focusView(view.id);
            else latest.addView(view, conversationPlacement(latest.layout, latest.pinnedViewIds));
            setLastConversation(id);
          })
          .catch((onRouteError) =>
            toast.error(
              onRouteError instanceof Error ? onRouteError.message : "Could not restore layout",
            ),
          );
        return;
      }
      navigate(
        `/c/${encodeURIComponent(id)}${options?.messageId ? `?message=${encodeURIComponent(options.messageId)}` : ""}`,
      );
    },
    [navigate],
  );
  const openConversationAt = useCallback((id: string, placement: DockPlacement) => {
    dockRef.current.addView(conversationView(id, titlesRef.current.get(id)), placement);
    setLastConversation(id);
    if (isMobileViewport()) setSidebarOpen(false);
  }, []);
  const acceptConversation = useCallback(
    (id: string) => dockRef.current.navigateConversation(id),
    [],
  );
  const restoredLayoutScope = useRef<string | null>(null);
  const onConversationAccepted = useCallback((id: string) => {
    const latest = dockRef.current;
    if (restoredLayoutScope.current !== latest.scopeKey) {
      restoredLayoutScope.current = latest.scopeKey;
      if (
        latest.activeConversationId === id &&
        latest.hasChatLayout &&
        latest.layout.views.length
      ) {
        setLastConversation(id);
        return;
      }
    }
    const existing = latest.layout.views.find((view) => view.id === `conversation:${id}`);
    if (existing) latest.focusView(existing.id);
    else
      latest.addView(
        conversationView(id, titlesRef.current.get(id)),
        conversationPlacement(latest.layout, latest.pinnedViewIds, lastConversationRef.current),
      );
    setLastConversation(id);
  }, []);
  const onRouteError = useCallback(
    (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not restore layout"),
    [],
  );
  const href = location.pathname + location.search + location.hash;
  const acceptedHref = useAcceptedConversationRoute({
    active,
    conversationId,
    href,
    scopeKey: dock.scopeKey,
    skip: skipLayoutForRoute,
    accept: acceptConversation,
    onAccepted: onConversationAccepted,
    navigate,
    onError: onRouteError,
  });
  useEffect(() => {
    if (
      !active ||
      focusedView?.kind !== "conversation" ||
      typeof focusedView.resource.conversationId !== "string"
    )
      return;
    setLastConversation(focusedView.resource.conversationId);
    void useChatStore.getState().switchTo(focusedView.resource.conversationId);
  }, [active, focusedView?.kind, focusedView?.resource.conversationId]);
  const ensureVisible = useCallback(() => {
    if (!activeRef.current) return;
    if (!showDockRef.current) navigate("/?view=workbench");
    if (isMobileViewport()) setSidebarOpen(false);
  }, [navigate]);
  const openPaneOverride = useRef<string | undefined>(undefined);
  const openView = useCallback(
    (request: OpenWorkbenchView, options?: { beside?: boolean; paneId?: string }) => {
      if (request.kind === "conversation" && request.conversationId) {
        openConversation(request.conversationId, { ...options, title: request.title });
        return;
      }
      if (
        request.shellResource &&
        (!request.shellResource.source ||
          !(request.shellResource.resource_id ?? request.shellResource.id))
      ) {
        toast.error("This shell has no recorded resource identity");
        return;
      }
      const captured = {
        ...request,
        conversationId:
          request.conversationId ??
          (request.kind === "activity" && request.source?.kind === "chat"
            ? request.source.conversationId
            : undefined),
        ...(request.focusAgentId || request.focusShellId ? { linkRequestId: randomUUID() } : {}),
        ...(request.shellResource
          ? {
              terminalOwner: "conversation" as const,
              terminalId: `${request.shellResource.source}:${request.shellResource.resource_id ?? request.shellResource.id}`,
              shellResource: {
                source: request.shellResource.source,
                resource_id: request.shellResource.resource_id ?? request.shellResource.id,
              },
            }
          : {}),
      };
      const overridePane = openPaneOverride.current;
      const targetPane =
        options?.paneId ?? overridePane ?? dockRef.current.layout.focusedPaneId ?? undefined;
      const needsFiles =
        captured.terminalOwner !== "conversation" &&
        ["files", "preview", "changes", "search", "terminal", "shells", "pr"].includes(
          captured.kind,
        );
      const add = (resource: OpenWorkbenchView) => {
        if (!mounted.current) return;
        if (!["files", "changes", "search"].includes(resource.kind)) {
          const existing = dockRef.current.layout.views.find(
            (view) =>
              view.kind === resource.kind &&
              view.resource.conversationId === resource.conversationId &&
              JSON.stringify(view.resource.source) === JSON.stringify(resource.source) &&
              (viewWorkspace(view)?.id ?? view.resource.workspaceId) ===
                (resource.workspace?.id ?? resource.workspaceId) &&
              view.resource.path === resource.path &&
              view.resource.terminalId === resource.terminalId,
          );
          if (existing) {
            const focus = () => {
              dockRef.current.focusView(existing.id);
              ensureVisible();
            };
            if (resource.fileOptions || resource.focusAgentId || resource.focusShellId) {
              void dockRef.current
                .updateView(existing.id, {
                  resource: JSON.parse(
                    JSON.stringify(
                      resource.focusAgentId || resource.focusShellId
                        ? {
                            ...existing.resource,
                            focusAgentId: resource.focusAgentId,
                            focusShellId: resource.focusShellId,
                            linkRequestId: resource.linkRequestId,
                          }
                        : resource,
                    ),
                  ) as Record<string, unknown>,
                })
                .then((allowed) => {
                  if (allowed) focus();
                });
            } else focus();
            return;
          }
        }
        const id = randomUUID();
        if (resource.kind === "search") explicitSearchViews.current.add(id);
        if (resource.workspace && resource.sourceViewId)
          inheritResourceViewState(
            resource.sourceViewId,
            id,
            resource.workspace.id,
            resource.fileOptions?.comparisonScope ?? "files",
          );
        if (
          resource.workspace &&
          resource.path &&
          ["files", "changes", "search", "pr"].includes(resource.kind)
        )
          setPanelFolder(panelFolderKey(resource.workspace.id, id)!, resource.path);
        const title =
          resource.title ||
          (resource.kind === "preview"
            ? resource.path?.split("/").at(-1)
            : VIEW_TYPES.find((entry) => entry.kind === resource.kind)?.label) ||
          "View";
        dockRef.current.addView(
          {
            id,
            kind: resource.kind,
            title,
            resource: JSON.parse(JSON.stringify(resource)) as Record<string, unknown>,
          },
          {
            paneId: targetPane,
            edge: overridePane || options?.beside === false ? undefined : "right",
          },
        );
        ensureVisible();
      };
      const resolve = async () => {
        if (captured.unavailableReason || captured.legacySessionResource) {
          add(captured);
          return;
        }
        let workspace = captured.workspace;
        if (needsFiles && !workspace && captured.conversationId) {
          try {
            workspace = await resolveChatWorkspace(captured.conversationId);
          } catch (error) {
            if (
              error instanceof ApiError &&
              [403, 404, 405, 501].includes(error.status) &&
              captured.kind !== "terminal"
            ) {
              add({ ...captured, legacySessionResource: true });
              return;
            }
            throw error;
          }
        }
        if (!mounted.current) return;
        if (needsFiles && !workspace) {
          setLocationRequest(captured);
          return;
        }
        if (captured.kind === "terminal" && !captured.terminalId) {
          const info = await createTerminal(
            captured.conversationId ?? "",
            "shell",
            workspace,
            captured.path,
          );
          if (!mounted.current) return;
          await queryClient.cancelQueries({
            queryKey: ["workbench-terminals", workspace!.id],
            exact: true,
          });
          await queryClient.invalidateQueries({ queryKey: ["workbench-terminals", workspace!.id] });
          add({
            ...captured,
            workspace,
            terminalId: info.id,
            title: `${info.name} · ${info.session}`,
          });
        } else add({ ...captured, ...(workspace ? { workspace } : {}) });
      };
      void resolve().catch((error) =>
        toast.error(error instanceof Error ? error.message : "Could not open view"),
      );
    },
    [ensureVisible, openConversation, queryClient],
  );
  const fileLink = useMemo(
    () => parseWorkbenchFileLink(conversationId, location.search),
    [conversationId, location.search],
  );
  const openedFileLink = useRef<string | null>(null);
  useEffect(() => {
    if (!active || acceptedHref !== href) return;
    if (!fileLink) {
      openedFileLink.current = null;
      return;
    }
    const key = href;
    if (openedFileLink.current === key) return;
    let cancelled = false;
    const request = { ...fileLink, linkRequestId: `${location.key}:${key}` };
    void resolveWorkbenchFileLink(request)
      .then((resolved) => {
        if (cancelled) return;
        openedFileLink.current = key;
        openView(resolved);
      })
      .catch((error) => {
        if (cancelled) return;
        openedFileLink.current = key;
        openView({
          ...request,
          unavailableReason:
            error instanceof Error ? error.message : "The linked resource is unavailable.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [active, acceptedHref, href, fileLink, location.key, openView]);
  const openBrowser = useCallback(
    (id: string) => openView({ kind: "browser", conversationId: id }),
    [openView],
  );
  const openFocused = useCallback(
    (kind: WorkbenchViewKind) =>
      openView({
        kind,
        source:
          kind === "activity"
            ? resourceConversationId
              ? { kind: "chat", conversationId: resourceConversationId }
              : selectedWorkspace?.host_id
                ? { kind: "host", hostId: selectedWorkspace.host_id, workspace: selectedWorkspace }
                : undefined
            : undefined,
        workspace: selectedWorkspace,
        conversationId: resourceConversationId,
        path: folderOwner
          ? (readPanelFolder(panelFolderKey(folderOwner, focusedView?.id)) ?? undefined)
          : undefined,
      }),
    [openView, selectedWorkspace, resourceConversationId, folderOwner, focusedView?.id],
  );
  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), []);
  const shortcutCallbacks = useRef({ openView, ensureVisible, queryClient });
  shortcutCallbacks.current = { openView, ensureVisible, queryClient };
  const [resourceShortcuts] = useState(() =>
    createWorkbenchResourceShortcuts({
      getLayout: () => dockRef.current.layout,
      openView: (request, options) => shortcutCallbacks.current.openView(request, options),
      focusView: (id) => {
        dockRef.current.focusView(id);
        shortcutCallbacks.current.ensureVisible();
      },
      onTerminalCreated: async (workspace) => {
        const currentClient = shortcutCallbacks.current.queryClient;
        await currentClient.cancelQueries({
          queryKey: ["workbench-terminals", workspace.id],
          exact: true,
        });
        await Promise.all([
          currentClient.invalidateQueries({ queryKey: ["workbench-terminals", workspace.id] }),
          currentClient.invalidateQueries({
            queryKey: ["workbench-terminal-history", workspace.id],
          }),
        ]);
      },
    }),
  );
  useEffect(() => resourceShortcuts.remember(focusedView), [resourceShortcuts, focusedView]);
  const runResourceShortcut = useCallback(
    (action: "openFiles" | "openTerminal" | "newTerminal") => {
      void resourceShortcuts[action]().catch((error) =>
        toast.error(error instanceof Error ? error.message : "Could not open workspace view"),
      );
    },
    [resourceShortcuts],
  );
  const search = useContextSearchController({
    activeSessionId: focusedConversationId,
    sidebarOpen,
    setSidebarOpen,
    navigate: (path, done, relevant) => {
      if (!activeRef.current || (relevant && !relevant())) return;
      const match = path.match(/^\/c\/([^/?#]+)/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        dockRef.current.addView(
          conversationView(id, titles.get(id)),
          conversationPlacement(
            dockRef.current.layout,
            dockRef.current.pinnedViewIds,
            lastConversation,
          ),
        );
        setLastConversation(id);
        ensureVisible();
        done();
      } else {
        navigate(path);
        done();
      }
    },
    onToggleLeftSidebar: toggleSidebar,
    onToggleRightSidebar: () => openFocused("files"),
    isMobile: isMobileViewport,
  });
  const findExplorer = useCallback(
    (replaceOpen = false) => {
      const element = getFindContext()?.target?.closest<HTMLElement>("[data-workbench-view]");
      const view =
        dockRef.current.layout.views.find((item) => item.id === element?.dataset.workbenchView) ??
        focusedView;
      const target = focusedResourceTarget(view);
      openView({
        kind: "search",
        replaceOpen,
        workspace: target.workspace,
        conversationId: target.conversationId,
        path: readPanelFolder(panelFolderKey(target.folderOwner, view?.id)) ?? undefined,
      });
    },
    [focusedView, openView],
  );
  const serverInfo = useServerInfo();
  const debug = useDebugMode();
  const openActions: WorkbenchOpenAction[] = [
    { id: "new-chat", label: "New chat", icon: MessageSquareIcon, run: () => navigate("/") },
    ...VIEW_TYPES.filter(
      (entry) =>
        (entry.kind !== "browser" || supportsBrowser()) &&
        (entry.kind !== "logs" || debug) &&
        (entry.kind !== "search" || isFeatureEnabled(serverInfo, "workspace_content_search")),
    ).map((entry) => ({
      id: `open-${entry.kind}`,
      label: entry.label,
      icon: entry.icon,
      disabled:
        ["agent-terminal", "browser", "logs"].includes(entry.kind) && !resourceConversationId,
      run: () => openFocused(entry.kind),
    })),
  ];
  const closeView = useCallback(async (id: string) => {
    const view = dockRef.current.layout.views.find((entry) => entry.id === id);
    const closed = await dockRef.current.closeView(id);
    if (closed && view && mounted.current)
      setClosedViews((previous) =>
        [...previous.filter((entry) => entry.id !== id), view].slice(-20),
      );
    return closed;
  }, []);
  const actions: ActionCommand[] = [
    ...focusedCommands,
    ...(focusedView
      ? [
          {
            id: "close-view",
            label: "Close focused view",
            icon: XIcon,
            keywords: ["tab", "pane", "close"],
            run: () => {
              void closeView(focusedView.id);
            },
          },
        ]
      : []),
    ...(closedViews.length
      ? [
          {
            id: "reopen-view",
            label: "Reopen closed view",
            icon: Undo2Icon,
            keywords: ["tab", "restore", "reopen"],
            run: () => {
              const view = closedViews.at(-1)!;
              dock.addView(view);
              setClosedViews((previous) => previous.filter((entry) => entry.id !== view.id));
              ensureVisible();
            },
          },
        ]
      : []),
    ...searchActions({
      navigate,
      onToggleLeftSidebar: toggleSidebar,
      onToggleRightSidebar: () => openFocused("files"),
    }).filter((action) => action.id !== "toggle-right-sidebar" && action.id !== "go-tasks"),
    ...openActions
      .filter((action) => !action.disabled && action.id !== "new-chat")
      .map((action) => ({
        ...action,
        keywords: ["open", "view", action.label, ...(VIEW_COMMAND_TERMS[action.id] ?? [])],
      })),
    {
      id: "conversation-search",
      label: "Search chat messages",
      icon: SearchIcon,
      keywords: ["find", "current", "all chats"],
      run: () => search.openSearch("all"),
    },
  ];
  const registerGuard = useCallback((viewId: string, guard: FileNavigationGuard) => {
    const set = guards.current.get(viewId) ?? new Set<FileNavigationGuard>();
    guards.current.set(viewId, set);
    set.add(guard);
    return () => {
      set.delete(guard);
      if (!set.size) guards.current.delete(viewId);
    };
  }, []);
  const updateResource = useCallback(async (view: DockView, patch: Record<string, unknown>) => {
    const current = dockRef.current.retainedViews.find((entry) => entry.id === view.id);
    if (!current || !sameDockResource(current, view))
      throw new Error(
        "This view changed while the selection was open. Reopen the selector and try again.",
      );
    return dockRef.current.updateView(view.id, {
      resource: JSON.parse(JSON.stringify({ ...current.resource, ...patch })) as Record<
        string,
        unknown
      >,
    });
  }, []);
  const renderView = useCallback(
    (view: DockView, visibility: DockViewVisibility) => {
      const resource = view.resource;
      const sessionId =
        typeof resource.conversationId === "string" ? resource.conversationId : undefined;
      const workspace = viewWorkspace(view);
      const path = typeof resource.path === "string" ? resource.path : undefined;
      let content;
      if (typeof resource.unavailableReason === "string")
        content = (
          <p role="alert" className="p-4 text-sm">
            {resource.unavailableReason} The linked location has been retained.
          </p>
        );
      else if (
        view.kind === "attachment-preview" &&
        resource.request &&
        typeof resource.request === "object" &&
        "sessionId" in resource.request &&
        typeof resource.request.sessionId === "string"
      )
        content = <AttachmentPreviewView request={resource.request as AttachmentPreviewRequest} />;
      else if (view.kind === "conversation" && sessionId)
        content = (
          <ConversationView
            conversationId={sessionId}
            visible={showDock && visibility.visible}
            focused={visibility.focused}
          />
        );
      else if (
        ["files", "changes", "preview", "search", "pr"].includes(view.kind) &&
        (workspace || (sessionId && resource.legacySessionResource === true))
      )
        content = (
          <ResourceView
            revealRequest={
              typeof resource.revealPath === "string" && typeof resource.revealToken === "string"
                ? { path: resource.revealPath, token: resource.revealToken }
                : undefined
            }
            originalDownload={
              resource.originalAttachment
                ? () => {
                    const original = resource.originalAttachment as AttachmentPreviewRequest;
                    const url = `/v1/sessions/${encodeURIComponent(original.sessionId)}/attachments/references/${encodeURIComponent(original.itemId ?? "")}?${new URLSearchParams({ path: original.reference ?? "" })}`;
                    void authenticatedFetch(url)
                      .then(async (response) => {
                        if (!response.ok) throw await apiErrorFromResponse(response);
                        downloadBlob(await response.blob(), original.filename ?? "Attachment");
                      })
                      .catch((error) =>
                        toast.error("Could not download captured original", {
                          description: String(error),
                        }),
                      );
                  }
                : undefined
            }
            viewId={view.id}
            kind={view.kind as "files" | "changes" | "preview" | "search" | "pr"}
            workspace={workspace}
            conversationId={sessionId}
            path={path}
            commentId={typeof resource.commentId === "string" ? resource.commentId : undefined}
            initialDiff={
              typeof resource.initialDiff === "boolean" ? resource.initialDiff : undefined
            }
            linkRequestId={
              typeof resource.linkRequestId === "string" ? resource.linkRequestId : undefined
            }
            active={showDock && visibility.visible}
            autoFocus={showDock && visibility.focused && explicitSearchViews.current.has(view.id)}
            replaceOpen={resource.replaceOpen === true}
            initialQuery={
              typeof resource.searchQuery === "string" ? resource.searchQuery : undefined
            }
            annotationControl={
              view.kind === "preview" ? (
                <ConversationSourcePicker
                  conversationId={sessionId}
                  label="Comments"
                  onChange={(id) => {
                    void dockRef.current.updateView(view.id, {
                      resource: { ...resource, conversationId: id },
                    });
                  }}
                />
              ) : undefined
            }
            position={
              typeof (resource.fileOptions as OpenFileOptions | undefined)?.line === "number"
                ? (resource.fileOptions as FilePosition)
                : undefined
            }
            comparisonScope={
              (resource.fileOptions as OpenWorkbenchView["fileOptions"])?.comparisonScope
            }
            onOpenFile={(file, options) =>
              openView({
                kind: "preview",
                workspace: options.workspace,
                conversationId: sessionId,
                path: file,
                fileOptions: options,
                sourceViewId: options.sourceViewId,
              })
            }
            onWorkspaceChange={(next) => updateResource(view, { workspace: next })}
            registerNavigationGuard={(guard) => registerGuard(view.id, guard)}
            onClose={() => {
              void closeView(view.id);
            }}
          />
        );
      else if (view.kind === "terminal" && sessionId && resource.shellResource)
        content = (
          <ShellResourceView
            conversationId={sessionId}
            shellResource={
              resource.shellResource as NonNullable<OpenWorkbenchView["shellResource"]>
            }
            active={showDock && visibility.visible}
          />
        );
      else if (view.kind === "terminal" && sessionId && resource.retainedActivity)
        content = (
          <RetainedActivityView
            conversationId={sessionId}
            activity={
              resource.retainedActivity as NonNullable<OpenWorkbenchView["retainedActivity"]>
            }
            active={showDock && visibility.visible}
          />
        );
      else if (view.kind === "terminal" && typeof resource.terminalId === "string")
        content = (
          <TerminalResourceView
            workspace={workspace}
            conversationId={sessionId}
            terminalId={resource.terminalId}
            manual={resource.terminalOwner !== "conversation"}
            active={showDock && visibility.visible && visibility.focused}
          />
        );
      else if (view.kind === "agent-terminal" && sessionId)
        content = (
          <AgentTerminal
            conversationId={sessionId}
            active={showDock && visibility.visible && visibility.focused}
          />
        );
      else if (view.kind === "activity" || view.kind === "shells")
        content = (
          <ActivityView
            viewId={view.id}
            focusAgentId={
              typeof resource.focusAgentId === "string" ? resource.focusAgentId : undefined
            }
            focusShellId={
              typeof resource.focusShellId === "string" ? resource.focusShellId : undefined
            }
            linkRequestId={
              typeof resource.linkRequestId === "string" ? resource.linkRequestId : undefined
            }
            active={showDock && visibility.visible}
            source={activitySource(resource, workspace, sessionId, view.kind === "shells")}
            onOpenAgent={(child) =>
              openView(
                { kind: "conversation", conversationId: child.id, title: subagentName(child) },
                { beside: true },
              )
            }
            canStopAgent={(child) => Boolean(child.busy)}
            onStopAgent={async (child) => {
              try {
                await interrupt(child.id);
                await queryClient.invalidateQueries({
                  predicate: (query) =>
                    query.queryKey[0] === "conversation" && query.queryKey[2] === "child_sessions",
                });
                await queryClient.invalidateQueries({ queryKey: ["native-child-capabilities"] });
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not stop sub-agent");
                throw error;
              }
            }}
            onConsumeLinkIntent={() => {
              void updateResource(view, {
                focusAgentId: undefined,
                focusShellId: undefined,
                linkRequestId: undefined,
              }).catch((error) =>
                toast.error(
                  error instanceof Error ? error.message : "Could not clear navigation request",
                ),
              );
            }}
            onSourceChange={async (source) => {
              const accepted = await updateResource(view, {
                source,
                focusAgentId: undefined,
                focusShellId: undefined,
                linkRequestId: undefined,
                ...(source.kind === "chat"
                  ? { conversationId: source.conversationId, workspace: undefined }
                  : { conversationId: undefined, workspace: source.workspace }),
              });
              if (!accepted)
                throw new Error(
                  "The Activity source changed before this selection could be applied. Please retry.",
                );
            }}
            onNewTerminal={(target) =>
              openView({ kind: "terminal", workspace: target, terminalOwner: "workspace" })
            }
            onOpenTerminal={(target) => {
              if (target.shellResource) {
                openView(
                  {
                    kind: "terminal",
                    conversationId: target.sessionId,
                    shellResource: target.shellResource,
                    terminalOwner: "conversation",
                    title:
                      target.shellResource.command ?? target.shellResource.description ?? "Shell",
                  },
                  { beside: true },
                );
                return;
              }
              if (target.retainedOnly && target.activity && !target.workspaceId) {
                openView({
                  kind: "terminal",
                  conversationId: target.sessionId,
                  terminalId: target.activity.id,
                  terminalOwner: "conversation",
                  title: target.activity.name,
                  retainedActivity: {
                    name: target.activity.name,
                    state: target.activity.state,
                    entryIds: target.activity.entries.map((entry) => entry.id),
                  },
                });
                return;
              }
              const launch = async () => {
                let terminalWorkspace: WorkbenchWorkspace | undefined;
                if (target.workspaceId) {
                  const response = await authenticatedFetch(
                    `/v1/workbench-workspaces/${encodeURIComponent(target.workspaceId)}`,
                  );
                  if (!response.ok) throw await apiErrorFromResponse(response);
                  terminalWorkspace = await response.json();
                }
                if (mounted.current)
                  openView({
                    kind: "terminal",
                    conversationId: target.sessionId,
                    terminalId: target.terminalId,
                    terminalOwner: target.workspaceId ? "workspace" : "conversation",
                    workspace: terminalWorkspace,
                  });
              };
              void launch().catch((error) =>
                toast.error(error instanceof Error ? error.message : "Could not open shell"),
              );
            }}
          />
        );
      else if (view.kind === "automations") content = <TasksPage />;
      else if (view.kind === "browser" && sessionId && supportsBrowser())
        content = (
          <BrowserPane
            conversationId={sessionId}
            active={showDock && visibility.visible}
            className="h-full"
          />
        );
      else if (view.kind === "logs" && sessionId && debug)
        content = (
          <ExecutionLogsPanel
            contained
            active={showDock && visibility.visible && visibility.focused}
            open
            conversationId={sessionId}
            initialKey="executionLog:main"
            onClose={() => {
              void closeView(view.id);
            }}
          />
        );
      else
        content = (
          <p role="status" className="p-4 text-sm">
            This view’s resource is unavailable. Its saved location has been retained.
          </p>
        );
      if (view.kind === "preview" && resource.originalAttachment && !resource.unavailableReason) {
        content = (
          <CapturedFileGate request={resource.originalAttachment as AttachmentPreviewRequest}>
            {content}
          </CapturedFileGate>
        );
      }
      return (
        <div className="h-full min-h-0" data-workbench-view={view.id}>
          <ViewCommandScope viewId={view.id}>
            <CapturedFileActions
              conversationId={sessionId}
              workspace={workspace}
              openView={openView}
              registerGuard={registerGuard}
              viewId={view.id}
            >
              {content}
            </CapturedFileActions>
          </ViewCommandScope>
        </div>
      );
    },
    [showDock, debug, openView, updateResource, registerGuard, closeView, queryClient],
  );
  const referenceNavigation = useMemo(
    () => ({ openConversation, createSubchat: createQuoteSubchat }),
    [openConversation],
  );
  const attachmentNavigation = useMemo(
    () => ({
      revealAttachment: async (request: AttachmentPreviewRequest) => {
        if (!request.itemId || !request.reference) return;
        const capturedScopeKey = dockRef.current.scopeKey;
        const layoutOwner = dockRef.current.activeConversationId;
        try {
          const response = await authenticatedFetch(
            `/v1/sessions/${encodeURIComponent(request.sessionId)}/attachments/references/${encodeURIComponent(request.itemId)}/location?${new URLSearchParams({ path: request.reference })}`,
          );
          if (!response.ok) throw await apiErrorFromResponse(response);
          const target = (await response.json()) as { workspace: WorkbenchWorkspace; path: string };
          if (
            !target.workspace?.id ||
            typeof target.workspace.root !== "string" ||
            typeof target.path !== "string"
          )
            throw new Error("The original file location is unavailable");
          const current = dockRef.current;
          if (current.scopeKey !== capturedScopeKey || current.activeConversationId !== layoutOwner)
            return;
          const existing = current.layout.views.find(
            (view) => view.kind === "files" && viewWorkspace(view)?.id === target.workspace.id,
          );
          const reveal = { revealPath: target.path, revealToken: randomUUID() };
          if (existing) {
            const accepted = await current.updateView(existing.id, {
              resource: { ...existing.resource, ...reveal },
            });
            if (accepted) dockRef.current.focusView(existing.id);
          } else {
            const id = randomUUID();
            setPanelFolder(panelFolderKey(target.workspace.id, id)!, target.workspace.root);
            current.addView(
              {
                id,
                kind: "files",
                title: "Explorer",
                resource: {
                  workspace: target.workspace,
                  conversationId: request.sessionId,
                  ...reveal,
                },
              },
              { paneId: current.layout.focusedPaneId ?? undefined, edge: "right" },
            );
          }
          ensureVisible();
        } catch (error) {
          toast.error("Could not reveal file", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      },
      canOpenAttachment: (request: AttachmentPreviewRequest) =>
        dockRef.current.layout.views.some(
          (view) =>
            view.kind === "conversation" && view.resource.conversationId === request.sessionId,
        ),
      openAttachment: async (
        request: AttachmentPreviewRequest,
        options?: { placement: AttachmentPreviewPlacement },
      ) => {
        const capturedScope = dockRef.current.scopeKey;
        const capturedOwner = dockRef.current.activeConversationId;
        const openingGeneration = ++attachmentOpenGeneration.current;
        const stillCurrent = () =>
          mounted.current &&
          attachmentOpenGeneration.current === openingGeneration &&
          dockRef.current.scopeKey === capturedScope &&
          dockRef.current.activeConversationId === capturedOwner;
        let live: { workspace: WorkbenchWorkspace; path: string } | undefined;
        try {
          if (
            request.reference &&
            request.itemId &&
            !request.attachment?.file_id &&
            !request.reference.startsWith("/v1/sessions/")
          ) {
            const resolved = await queryClient.fetchQuery({
              queryKey: [
                "chat-file-location",
                request.sessionId,
                request.itemId,
                request.reference,
              ],
              queryFn: ({ signal }) =>
                fetchChatFileLocation(
                  request.sessionId,
                  request.itemId!,
                  request.reference!,
                  signal,
                ),
              staleTime: 30_000,
            });
            if (resolved.kind === "file") live = resolved;
            else if (resolved.kind !== "captured")
              throw new Error("This reference is not an available regular file");
          }
        } catch (error) {
          if (stillCurrent())
            toast.error(`Could not open ${request.filename ?? "file"}`, {
              description: error instanceof Error ? error.message : String(error),
            });
          return;
        }
        if (!stillCurrent()) return;
        const current = dockRef.current;
        if (current.scopeKey !== capturedScope || current.activeConversationId !== capturedOwner)
          return;
        const origin = current.layout.views.find(
          (view) =>
            view.kind === "conversation" && view.resource.conversationId === request.sessionId,
        );
        const originPane = origin && dockPaneForView(current.layout, origin.id);
        if (!originPane) {
          toast.error("The originating chat is no longer open");
          return;
        }
        const mode =
          options?.placement === "tab"
            ? "same"
            : options?.placement === "beside"
              ? "beside"
              : readFileOpening();
        const placement = filePlacement(current.layout, originPane.id, mode, current.pinnedViewIds);
        const identity = JSON.stringify([
          request.sessionId,
          request.itemId,
          request.reference,
          request.attachment,
        ]);
        const existing = current.layout.views.find((view) =>
          live
            ? view.kind === "preview" &&
              viewWorkspace(view)?.id === live.workspace.id &&
              view.resource.path === live.path
            : view.kind === "attachment-preview" && view.resource.identity === identity,
        );
        if (existing) {
          if (live) {
            try {
              await queryClient.fetchQuery(capturedFileQuery(request));
            } catch (error) {
              if (stillCurrent())
                toast.error("Could not prepare file", { description: String(error) });
              return;
            }
            if (!stillCurrent()) return;
            const reused = dockRef.current.layout.views.find((view) => view.id === existing.id);
            if (!reused || !sameDockResource(existing, reused)) return;
            const originalAttachment = JSON.parse(JSON.stringify(request));
            const resource = { ...reused.resource, originalAttachment };
            if (!sameDockResource(reused, { ...reused, resource })) {
              await dockRef.current.updateView(reused.id, { resource });
              if (!stillCurrent()) return;
            }
          }
          const latest = dockRef.current;
          const latestOrigin = dockPaneForView(latest.layout, origin.id);
          if (!latestOrigin) return;
          const destination = filePlacement(
            latest.layout,
            latestOrigin.id,
            mode,
            latest.pinnedViewIds,
          );
          const pane = dockPaneForView(latest.layout, existing.id);
          if (
            (options?.placement === "tab" || options?.placement === "beside") &&
            (pane?.id !== destination.paneId || destination.edge)
          )
            latest.setLayout((layout) => moveDockView(layout, existing.id, destination));
          else latest.focusView(existing.id);
        } else
          current.addView(
            {
              id: randomUUID(),
              kind: live ? "preview" : "attachment-preview",
              title:
                request.filename ||
                request.attachment?.filename ||
                request.reference?.split("/").at(-1) ||
                "Attachment",
              resource: live
                ? {
                    workspace: live.workspace,
                    path: live.path,
                    conversationId: request.sessionId,
                    originalAttachment: JSON.parse(JSON.stringify(request)),
                  }
                : { request: JSON.parse(JSON.stringify(request)), identity },
            },
            placement,
          );
        ensureVisible();
      },
    }),
    [ensureVisible, queryClient],
  );
  const openConversationIds = useMemo(
    () =>
      dock.layout.views
        .filter((view) => view.kind === "conversation")
        .map((view) => String(view.resource.conversationId)),
    [dock.layout.views],
  );
  const workbench = useMemo(
    () => ({ openConversation, openView, focusedConversationId, openConversationIds }),
    [openConversation, openView, focusedConversationId, openConversationIds],
  );
  return (
    <WorkbenchProvider value={workbench}>
      <AttachmentPreviewContext.Provider value={attachmentNavigation}>
        <ContextReferenceNavigationContext.Provider value={referenceNavigation}>
          <ContextSearchProvider value={search}>
            {active && (
              <WorkbenchBindings
                conversationId={focusedConversationId}
                approvalConversationId={
                  showDock && focusedView?.kind === "conversation"
                    ? (focusedConversationId ?? null)
                    : null
                }
                conversations={loadedConversations}
                onChatFind={search.openSearch}
                onExplorerFind={findExplorer}
                onTogglePalette={() => {
                  setSessionsOnly(false);
                  setPaletteOpen((value) => !value);
                }}
                onSessionSearch={() => {
                  setSessionsOnly(true);
                  setPaletteOpen(true);
                }}
                onToggleSidebar={toggleSidebar}
                onOpenFiles={() => runResourceShortcut("openFiles")}
                onOpenTerminal={() => runResourceShortcut("openTerminal")}
                onNewTerminal={() => runResourceShortcut("newTerminal")}
                onSidebarDrag={handleSidebarDrag}
                onOpenBrowser={openBrowser}
              />
            )}
            <NotificationLayoutProvider
              width={320}
              bottom="calc(1rem + var(--omnigent-inset-bottom, 0px))"
            >
              <div
                className="app-shell unified-workbench flex h-dvh min-h-0 flex-col bg-background text-foreground"
                data-ios-native={isIOSShell() || undefined}
                data-android-native={isAndroidShell() || undefined}
              >
                {active && (
                  <WorkbenchAppBar
                    sidebarOpen={sidebarOpen}
                    onToggleSidebar={toggleSidebar}
                    onSearch={() => {
                      setSessionsOnly(false);
                      setPaletteOpen(true);
                    }}
                    onSettings={() => navigate("/settings")}
                    openActions={openActions}
                  />
                )}
                <div className="relative flex min-h-0 min-w-0 flex-1">
                  {active && (
                    <Sidebar
                      workbench
                      dragProgress={sidebarDragProgress}
                      open={sidebarOpen}
                      onOpen={() => setSidebarOpen(true)}
                      onClose={() => setSidebarOpen(false)}
                      onOpenSearch={() => search.openSearch("all")}
                    />
                  )}
                  <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    {dock.error && (
                      <p role="status" className="px-3 py-1 text-sm text-destructive">
                        Layout could not be saved: {dock.error.message}
                      </p>
                    )}
                    <div
                      className={showDock ? "relative flex min-h-0 flex-1" : "hidden"}
                      inert={!showDock}
                    >
                      <DockWorkspace
                        active={showDock}
                        openActions={openActions}
                        onOpenAction={(paneId, action) => {
                          openPaneOverride.current = paneId;
                          try {
                            action.run();
                          } finally {
                            openPaneOverride.current = undefined;
                          }
                        }}
                        scopeKey={dock.scopeKey}
                        layoutKey={dock.activeConversationId ?? "shared"}
                        canSuspendView={canSuspendView}
                        layout={dock.layout}
                        retainedViews={dock.retainedViews}
                        onLayoutChange={dock.setLayout}
                        renderView={renderView}
                        onBeforeClose={closeGuard}
                        onCloseView={closeView}
                        pinnedViewIds={dock.pinnedViewIds}
                        onOpenConversationAt={openConversationAt}
                        onPinView={(id) => dock.pinView(id)}
                        onUnpinView={(id) => dock.unpinView(id)}
                      />
                      {!dock.layout.views.length && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
                          <p className="text-xl text-muted-foreground">
                            Open a chat or tool to get started.
                          </p>
                          <OpenViewMenu actions={openActions}>
                            <Button variant="default">
                              <PlusIcon className="size-4" />
                              Open view
                            </Button>
                          </OpenViewMenu>
                        </div>
                      )}
                    </div>
                    {active && !showDock && (
                      <div className="workbench-routed-page flex min-h-0 flex-1 flex-col overflow-auto">
                        <Outlet />
                      </div>
                    )}
                  </main>
                </div>
              </div>
              {active && (
                <CommandPalette
                  anchorSelector="[data-workbench-search]"
                  sessionsOnly={sessionsOnly}
                  open={paletteOpen}
                  onOpenChange={setPaletteOpen}
                  onNavigate={(path) => {
                    const match = path.match(/^\/c\/([^/]+)$/);
                    if (match) openConversation(decodeURIComponent(match[1]));
                    else navigate(path);
                  }}
                  actions={actions}
                  fileTarget={paletteFileTarget}
                  onOpenFile={(path, target) =>
                    openView({
                      kind: "preview",
                      workspace: target.workspace,
                      conversationId: target.conversationId,
                      path: joinBrowseLocation(target.folder ?? "", path),
                    })
                  }
                  onFileSearch={(query, target) =>
                    openView({
                      kind: "search",
                      workspace: target.workspace,
                      conversationId: target.conversationId,
                      path: target.folder,
                      searchQuery: query,
                    })
                  }
                  onOpenProjects={() => {
                    search.close();
                    setSidebarOpen(true);
                  }}
                  onToggleLeftSidebar={toggleSidebar}
                  onToggleRightSidebar={() => openFocused("files")}
                  onMessageSearch={(id, query, target, filter) => {
                    dock.addView(
                      conversationView(id, titles.get(id)),
                      conversationPlacement(dock.layout, dock.pinnedViewIds, lastConversation),
                    );
                    setLastConversation(id);
                    ensureVisible();
                    if (target) search.openResult(target, query, filter);
                    else {
                      search.openSearch("current");
                      search.setQuery(query);
                      if (filter) search.setMessageFilter(filter);
                    }
                  }}
                />
              )}
              {active && (
                <OpenLocationDialog
                  open={locationRequest !== null}
                  onClose={() => setLocationRequest(null)}
                  onSelect={(workspace) => {
                    const request = locationRequest;
                    setLocationRequest(null);
                    if (request) openView({ ...request, workspace });
                  }}
                />
              )}
              {active && !embedded && <ImportReviewGate />}
              {active && isFeatureEnabled(serverInfo, "arca_shutdown_warnings") && (
                <ArcaShutdownToast />
              )}
              {active && <Toaster />}
              {active && <OverlayScrollbars />}
            </NotificationLayoutProvider>
          </ContextSearchProvider>
        </ContextReferenceNavigationContext.Provider>
      </AttachmentPreviewContext.Provider>
    </WorkbenchProvider>
  );
}

function AgentTerminal({ conversationId, active }: { conversationId: string; active: boolean }) {
  const { terminals, isLoading, error } = useTerminals(conversationId, { workspace: null });
  const terminal = findAgentTerminal(terminals);
  if (!terminal)
    return (
      <p role="status" className="p-4 text-sm">
        {error
          ? error.message
          : isLoading
            ? "Loading agent terminal…"
            : "This conversation has no available agent terminal."}
      </p>
    );
  return (
    <TerminalResourceView
      conversationId={conversationId}
      terminalId={terminal.id}
      active={active}
      manual={false}
    />
  );
}
