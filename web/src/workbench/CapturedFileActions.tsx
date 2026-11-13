// Modified for Triune.
import { useMemo, useRef, type ReactNode } from "react";
import { useStableCallback } from "@/hooks/useStableCallback";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { toast } from "@/lib/notifications";
import {
  FileViewerContext,
  type FileNavigationGuard,
  type OpenFileOptions,
} from "@/shell/FileViewerContext";
import type { WorkbenchWorkspace } from "@/lib/workbenchWorkspace";
import type { WorkbenchActions } from "./WorkbenchContext";

export function CapturedFileActions({
  conversationId,
  workspace,
  openView: openViewProp,
  registerGuard: registerGuardProp,
  viewId,
  children,
}: {
  conversationId?: string;
  workspace?: WorkbenchWorkspace;
  openView: WorkbenchActions["openView"];
  registerGuard: (id: string, guard: FileNavigationGuard) => () => void;
  viewId: string;
  children: ReactNode;
}) {
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const workspaceRoot = workspace?.root ?? null;
  const workspaceHome = workspace?.home ?? null;
  const sessionHostId = workspace?.host_id;
  const openView = useStableCallback(openViewProp);
  const registerGuard = useStableCallback(registerGuardProp);
  const value = useMemo(
    () => ({
      conversationId,
      workspaceRoot,
      workspaceHome,
      sessionHostId,
      isChangedPath: () => false,
      openGithubTab: () =>
        openView({ kind: "pr", workspace: workspaceRef.current, conversationId }),
      openContentSearch: (path: string, replaceOpen?: boolean) =>
        openView({
          kind: "search",
          workspace: workspaceRef.current,
          conversationId,
          path,
          replaceOpen,
        }),
      openFile: (path: string, options?: OpenFileOptions) => {
        const launch = async () => {
          let target = workspaceRef.current;
          if (options?.workspaceId && options.workspaceId !== target?.id) {
            const response = await authenticatedFetch(
              `/v1/workbench-workspaces/${encodeURIComponent(options.workspaceId)}`,
            );
            if (!response.ok) throw await apiErrorFromResponse(response);
            target = await response.json();
          }
          openView({
            kind: "preview",
            workspace: target,
            conversationId,
            path,
            fileOptions: options,
          });
        };
        void launch().catch((error) =>
          toast.error(error instanceof Error ? error.message : "Could not open file"),
        );
      },
      registerNavigationGuard: (guard: FileNavigationGuard) => registerGuard(viewId, guard),
    }),
    [conversationId, workspaceRoot, workspaceHome, sessionHostId, openView, registerGuard, viewId],
  );
  return <FileViewerContext.Provider value={value}>{children}</FileViewerContext.Provider>;
}
