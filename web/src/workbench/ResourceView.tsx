// Modified for Triune; inherited notices remain applicable.
import { ArrowUpIcon } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useHosts } from "@/hooks/useHosts";
import { useSession } from "@/hooks/useSession";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import {
  ResourceViewIdContext,
  usePanelFolder,
  useResourceViewState,
  panelFolderKey,
  setPanelFolder,
} from "@/lib/panelFolder";
import { WorkbenchWorkspaceProvider, type WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import { joinBrowseLocation } from "@/lib/workspacePaths";
import {
  getWorkspaceComparison,
  setWorkspaceComparison,
  type WorkspaceComparison,
} from "@/lib/workspaceComparison";
import { getExplorerGitScope, setExplorerGitScope } from "@/lib/explorerGitScope";
import { TooltipButton } from "@/components/ui/tooltip";
import { FilesPanel } from "@/shell/FilesPanel";
import { ContentSearchPanel } from "@/shell/ContentSearchPanel";
import { FileViewer } from "@/shell/FileViewer";
import { PullRequestPanel } from "@/shell/PullRequestPanel";
import { WorkspaceSelectionDialog } from "@/shell/WorkspaceSelectionDialog";
import { WorkspaceSelector } from "@/shell/WorkspaceSelector";
import { parentOf } from "@/shell/WorkspacePicker";
import {
  FileViewerContext,
  type FileNavigationGuard,
  type FilePosition,
  type OpenFileOptions,
} from "@/shell/FileViewerContext";
import type { ChangedSort } from "@/shell/FlatFileList";

export interface ResourceOpenFileOptions extends OpenFileOptions {
  workspace?: WorkbenchWorkspace;
  sourceViewId: string;
  comparison?: WorkspaceComparison;
}
export interface ResourceViewProps {
  revealRequest?: { path: string; token: string };
  viewId: string;
  active?: boolean;
  annotationControl?: ReactNode;
  /** Download the captured attachment independently of this live file. */
  originalDownload?: () => void;
  initialQuery?: string;
  replaceOpen?: boolean;
  autoFocus?: boolean;
  kind: "files" | "changes" | "search" | "preview" | "pr";
  workspace?: WorkbenchWorkspace;
  /** Explicit comment/captured-change owner; the sidebar can choose one when absent. */
  conversationId?: string;
  path?: string;
  commentId?: string;
  initialDiff?: boolean;
  linkRequestId?: string;
  position?: FilePosition;
  comparisonScope?: "files" | "changes";
  onOpenFile: (path: string, options: ResourceOpenFileOptions) => void;
  onWorkspaceChange?: (workspace: WorkbenchWorkspace) => boolean | void | Promise<boolean | void>;
  registerNavigationGuard?: (guard: FileNavigationGuard) => () => void;
  onClose?: () => void;
}

/** A captured resource target; the shell owns placement and accepted target changes. */
export function ResourceView(props: ResourceViewProps) {
  if (!props.workspace && !props.conversationId)
    return <p role="status">No resource target selected.</p>;
  return (
    <ResourceViewIdContext.Provider value={props.viewId}>
      <WorkbenchWorkspaceProvider
        value={
          props.workspace
            ? { ...props.workspace, chatSessionId: props.conversationId ?? null }
            : null
        }
      >
        <ResourceViewBody
          key={`${props.viewId}:${props.workspace?.id ?? props.conversationId}`}
          {...props}
        />
      </WorkbenchWorkspaceProvider>
    </ResourceViewIdContext.Provider>
  );
}

function ResourceViewBody({
  revealRequest,
  viewId,
  active = true,
  annotationControl,
  originalDownload,
  initialQuery,
  replaceOpen = false,
  autoFocus = false,
  kind,
  workspace,
  conversationId,
  path,
  commentId,
  initialDiff,
  linkRequestId,
  position,
  comparisonScope,
  onOpenFile,
  onWorkspaceChange,
  registerNavigationGuard,
  onClose,
}: ResourceViewProps) {
  const inheritedContext = useContext(FileViewerContext);
  const { session } = useSession(conversationId);
  const owningHostId = workspace?.host_id ?? session?.hostId;
  const hosts = useHosts({ enabled: !!owningHostId, includeSandbox: true });
  const owner = workspace?.id ?? conversationId;
  const root = workspace?.root ?? session?.workspace ?? null;
  const folder = usePanelFolder(owner, root, viewId);
  const [showHidden, setShowHidden] = useResourceViewState(owner, viewId, "hidden", false);
  const [sort, setSort] = useResourceViewState<ChangedSort>(owner, viewId, "sort", "alpha");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guardRef = useRef<FileNavigationGuard | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const registerGuard = useCallback(
    (guard: FileNavigationGuard) => {
      guardRef.current = guard;
      const unregister = registerNavigationGuard?.(guard);
      return () => {
        if (guardRef.current === guard) guardRef.current = undefined;
        unregister?.();
      };
    },
    [registerNavigationGuard],
  );
  const guardTransition = useCallback((apply: () => void) => {
    if (guardRef.current) guardRef.current("", undefined, apply);
    else apply();
  }, []);
  const openFile = useCallback(
    (nextPath: string, options?: OpenFileOptions) => {
      const scope = kind === "changes" ? "changes" : kind === "files" ? "files" : comparisonScope;
      const comparison = getWorkspaceComparison({
        workspaceId: workspace?.id,
        conversationId,
        viewId,
        view: scope,
      });
      onOpenFile(nextPath, {
        ...options,
        workspaceId: workspace?.id,
        workspace,
        sourceViewId: viewId,
        comparisonScope: scope,
        comparison,
      });
    },
    [workspace, conversationId, viewId, kind, comparisonScope, onOpenFile],
  );
  const context = useMemo(
    () => ({
      openFile,
      openContentSearch: inheritedContext?.openContentSearch,
      registerNavigationGuard: registerGuard,
      beforeWorkspaceChange: guardTransition,
      openGithubTab: () => {},
      isChangedPath: () => false,
      conversationId,
      workspaceRoot: root,
      workspaceHome: workspace?.home ?? null,
      sessionHostId: workspace?.host_id ?? session?.hostId,
      activeFilePath: path,
    }),
    [
      openFile,
      inheritedContext?.openContentSearch,
      registerGuard,
      guardTransition,
      conversationId,
      workspace,
      root,
      session?.hostId,
      path,
    ],
  );

  async function changeLocation(hostId: string, nextRoot: string) {
    if (!workspace || !onWorkspaceChange) return false;
    setBusy(true);
    setError(null);
    try {
      const response = await authenticatedFetch("/v1/workbench-workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_id: hostId, root: nextRoot }),
      });
      if (!response.ok) throw await apiErrorFromResponse(response);
      const next = (await response.json()) as WorkbenchWorkspace;
      if (!next?.id || typeof next.root !== "string" || !Array.isArray(next.capabilities))
        throw new Error("The server returned an invalid workspace identity.");
      if (!mounted.current) return false;
      const capturedNext = { ...next, chatSessionId: null };
      const apply = async () => {
        const accepted = await onWorkspaceChange(capturedNext);
        if (accepted === false) return false;
        setPanelFolder(panelFolderKey(next.id, viewId)!, null);
        return true;
      };
      if (registerNavigationGuard) return await apply();
      const guard = guardRef.current;
      if (!guard) return await apply();
      const accepted = await new Promise<boolean>((resolve) => {
        guard(
          "",
          { workspaceId: next.id },
          () => resolve(true),
          () => resolve(false),
        );
      });
      return accepted ? await apply() : false;
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const selectedHost = hosts.data?.find((host) => host.host_id === owningHostId);
  const hostLabel = selectedHost?.name ?? owningHostId ?? workspace?.target_kind ?? "Host";
  const unavailable = workspace?.available === false || selectedHost?.status === "offline";
  const selectedPath = workspace ? joinBrowseLocation(workspace.root, folder) : (root ?? "");
  const parentPath = parentOf(selectedPath);
  const locationControls = workspace ? (
    <div className="flex min-w-0 items-center gap-1">
      <TooltipButton
        type="button"
        aria-label="Up one folder"
        disabled={busy || !onWorkspaceChange || !workspace.host_id || !parentPath}
        className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-40"
        onClick={() => {
          if (workspace.host_id && parentPath)
            void changeLocation(workspace.host_id, parentPath).catch((failure) => {
              if (mounted.current)
                setError(failure instanceof Error ? failure.message : String(failure));
            });
        }}
      >
        <ArrowUpIcon className="size-3.5" />
      </TooltipButton>
      <WorkspaceSelector
        hostLabel={selectedHost?.name ?? workspace.host_id ?? workspace.target_kind}
        path={selectedPath}
        disabled={busy || !onWorkspaceChange}
        onClick={() => setPickerOpen(true)}
      />
    </div>
  ) : null;
  return (
    <FileViewerContext.Provider value={context}>
      <div className="flex h-full min-h-0 flex-col" data-resource-view={viewId}>
        {hosts.error && (
          <p role="alert" className="px-2 text-xs text-destructive">
            Could not load hosts: {hosts.error.message}
          </p>
        )}
        {error && (
          <p role="alert" className="px-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {unavailable && (
          <p role="status" className="px-2 text-xs text-muted-foreground">
            Location unavailable: {workspace?.host_id ?? workspace?.target_kind} · {root}
          </p>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {(kind === "files" || kind === "changes") && (
            <FilesPanel
              revealRequest={revealRequest}
              locationControls={locationControls}
              viewId={viewId}
              active={active}
              conversationId={conversationId}
              workspaceId={workspace?.id}
              view={kind}
              flatView={kind === "changes"}
              onFileSelect={openFile}
              showHidden={showHidden}
              onShowHiddenChange={setShowHidden}
              sort={sort}
              onSortChange={setSort}
              frameless
              hideLocation={!!workspace}
            />
          )}
          {kind === "search" && (
            <ContentSearchPanel
              initialQuery={initialQuery}
              replaceOpen={replaceOpen}
              autoFocus={active && autoFocus}
              locationControls={locationControls}
              viewId={viewId}
              conversationId={conversationId ?? ""}
              scope={folder}
              onFileSelect={openFile}
            />
          )}
          {kind === "pr" && (
            <PullRequestPanel
              locationControls={locationControls}
              hideLocation={!!workspace}
              active={active}
              viewId={viewId}
              conversationId={conversationId ?? ""}
            />
          )}
          {kind === "preview" &&
            (path ? (
              <FileViewer
                hostLabel={hostLabel}
                annotationControl={annotationControl}
                originalDownload={originalDownload}
                viewId={viewId}
                conversationId={conversationId ?? ""}
                agentId={session?.agentId ?? null}
                recipientValid={!!conversationId}
                workspaceId={workspace?.id}
                path={path}
                commentId={commentId}
                initialDiff={initialDiff}
                linkRequestId={linkRequestId}
                position={position}
                comparisonScope={comparisonScope}
                permissionLevel={workspace?.permission_level ?? session?.permissionLevel}
                open
                mediaActive={active}
                syncUrl={false}
                frameless
                onClose={() => guardTransition(() => onClose?.())}
                onNavigateTo={openFile}
              />
            ) : (
              <p role="status" className="p-3 text-sm">
                No file selected.
              </p>
            ))}
        </div>
        {workspace && (
          <WorkspaceSelectionDialog
            open={pickerOpen}
            hostId={workspace.host_id}
            hostLabel={selectedHost?.name ?? workspace.host_id ?? workspace.target_kind}
            initialPath={selectedPath}
            onOpenChange={setPickerOpen}
            busy={busy}
            onConfirm={({ hostId, path: nextRoot }) => {
              if (!hostId) throw new Error("Select an available host for this workspace.");
              return changeLocation(hostId, nextRoot);
            }}
          />
        )}
      </div>
    </FileViewerContext.Provider>
  );
}

/** Copy opening choices once; a preview never follows its source Explorer. */
export function inheritResourceViewState(
  sourceViewId: string,
  viewId: string,
  workspaceId: string | undefined,
  view: "files" | "changes",
  conversationId?: string,
) {
  const source = { workspaceId, conversationId, viewId: sourceViewId, view };
  const target = { workspaceId, conversationId, viewId, view };
  setWorkspaceComparison(target, getWorkspaceComparison(source));
  setExplorerGitScope(target, getExplorerGitScope(source));
}
