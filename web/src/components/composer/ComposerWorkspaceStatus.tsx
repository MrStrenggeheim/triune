// Modified for Triune.
import type { ReactNode } from "react";
import { FolderIcon, GitForkIcon, Loader2Icon } from "lucide-react";

import { COMPOSER_WORKSPACE_COLLAPSED_LABEL_CLASS } from "./ChatComposer";
import type { ComposerBranchState } from "@/hooks/useComposerGitStatus";
import { cn } from "@/lib/utils";
import { COMPOSER_CONTROL_TEXT_CLASS } from "./ComposerControls";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Trailing path segment, e.g. ``feature-login``. */
function pathTail(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Trigger label for each branch state — no state is dressed up as another. */
function branchLabel(state: ComposerBranchState, branch: string | null): string {
  switch (state) {
    case "branch":
      return branch ?? "No branch";
    case "detached":
      return "Detached HEAD";
    case "not-git":
      return "Not a Git repository";
    case "loading":
      return "Checking branch…";
    case "unknown":
      return "Branch unavailable";
  }
}

/** Workspace identity and optional switch control for an existing session's composer. */
export function ComposerWorkspaceStatus({
  workspaceControl,
  workspacePath,
  worktreePath,
  isWorktree,
  branch,
  branchState,
  creationBranch,
  showWorktree,
}: {
  workspaceControl?: ReactNode;
  workspacePath: string | null;
  worktreePath: string | null;
  isWorktree: boolean | null;
  branch: string | null;
  branchState: ComposerBranchState;
  creationBranch: string | null;
  showWorktree: boolean;
}) {
  const branchText = branchLabel(branchState, branch);
  const branchTitle =
    creationBranch && (branchState !== "branch" || creationBranch !== branch)
      ? `${branchText}. Created on branch ${creationBranch}.`
      : branchText;

  return (
    <>
      {workspaceControl ?? (
        <WorkspaceStatusItem
          icon={FolderIcon}
          label={workspacePath ? pathTail(workspacePath) : "No workspace"}
          title={
            workspacePath ? `Working directory: ${workspacePath}` : "No working directory bound"
          }
          ariaLabel={
            workspacePath
              ? `Working directory: ${workspacePath}`
              : "Working directory: Not selected"
          }
          testId="composer-workspace-dir"
        />
      )}
      {showWorktree ? (
        <WorkspaceStatusItem
          icon={branchState === "loading" ? Loader2Icon : GitForkIcon}
          pending={branchState === "loading"}
          label={branchText}
          title={
            isWorktree && worktreePath ? `Worktree: ${worktreePath}. ${branchTitle}` : branchTitle
          }
          ariaLabel={`Worktree: ${branchText}`}
          testId="composer-git-branch"
        />
      ) : null}
    </>
  );
}

function WorkspaceStatusItem({
  icon: Icon,
  label,
  title,
  ariaLabel,
  testId,
  pending = false,
}: {
  icon: typeof FolderIcon;
  label: string;
  title: string;
  ariaLabel: string;
  testId: string;
  pending?: boolean;
}) {
  const item = (
    <span
      className={cn(
        "relative inline-flex h-8 min-w-0 max-w-40 items-center gap-1 px-1 md:h-7",
        COMPOSER_CONTROL_TEXT_CLASS,
      )}
      aria-label={ariaLabel}
      aria-busy={pending || undefined}
      data-testid={testId}
    >
      <Icon
        className={cn("size-3.5 shrink-0", pending && "animate-spin motion-reduce:animate-none")}
        aria-hidden
      />
      <span
        data-workspace-collapse-label=""
        className={cn("min-w-0 truncate text-left", COMPOSER_WORKSPACE_COLLAPSED_LABEL_CLASS)}
      >
        {label}
      </span>
    </span>
  );
  return title === label ? (
    item
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
