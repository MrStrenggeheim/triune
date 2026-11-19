// Modified for Triune.
import { useRef, useState } from "react";
import { useMenuInputIntent } from "@/hooks/useMenuInputIntent";
import {
  FolderIcon,
  LightbulbIcon,
  MessagesSquareIcon,
  PaperclipIcon,
  PlusIcon,
  TargetIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const EMPTY_PROJECTS: readonly { name: string }[] = [];

export function ComposerAddMenu({
  disabled,
  pendingLabel,
  onAttach,
  attachDisabled = false,
  onGoal,
  goalActive = false,
  goalDisabled = false,
  goalDescription = "Available after starting a session",
  showGoal = true,
  showPlan = true,
  planDisabled = false,
  planLabel,
  testIdPrefix = "composer",
  onPlan,
  planActive,
  onSideChat,
  sideChatLabel = "Start a new side chat",
  sideChatDisabled = false,
  projects = EMPTY_PROJECTS,
  onProjectSelect,
}: {
  disabled: boolean;
  pendingLabel?: string;
  onAttach: () => void;
  attachDisabled?: boolean;
  onGoal?: () => void;
  goalActive?: boolean;
  goalDisabled?: boolean;
  goalDescription?: string;
  showGoal?: boolean;
  showPlan?: boolean;
  planDisabled?: boolean;
  planLabel?: string;
  testIdPrefix?: string;
  onPlan?: () => void;
  planActive: boolean;
  /** Start a new side chat (a fork of this conversation opened as a rail tab).
   *  Absent when the session can't host one. */
  onSideChat?: () => void;
  sideChatLabel?: string;
  sideChatDisabled?: boolean;
  projects?: readonly { name: string }[];
  onProjectSelect?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { pointerInteraction, setPointerInteraction } = useMenuInputIntent(open);
  const [showProjects, setShowProjects] = useState(false);
  const pendingGoalRef = useRef(false);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setShowProjects(false);
        setOpen(nextOpen);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          menuFeedback="composer"
          className="size-8 rounded-lg data-[pointer-interaction=true]:focus-visible:ring-0 data-[pointer-interaction=true]:focus-visible:border-transparent md:size-7"
          data-pointer-interaction={pointerInteraction || undefined}
          onPointerDownCapture={() => setPointerInteraction(true)}
          onKeyDownCapture={() => setPointerInteraction(false)}
          disabled={disabled}
          loading={!!pendingLabel}
          aria-label={pendingLabel ?? "Add"}
          tooltip={pendingLabel ?? "Attach"}
          data-testid={`${testIdPrefix}-attach`}
          componentId={`${testIdPrefix}.add_menu`}
        >
          <PlusIcon
            className="size-4"
            data-icon-size="16"
            data-testid={`${testIdPrefix}-attach-icon`}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        onPointerDownCapture={() => setPointerInteraction(true)}
        onKeyDownCapture={() => setPointerInteraction(false)}
        onPointerDownOutside={() => setPointerInteraction(true)}
        onCloseAutoFocus={() => {
          if (pendingGoalRef.current) {
            pendingGoalRef.current = false;
            requestAnimationFrame(() => onGoal?.());
          }
        }}
        side="top"
        align="center"
        sideOffset={6}
        aria-label="Add"
        className="composer-add-menu rounded-[16px]"
        data-testid={`${testIdPrefix}-add-menu`}
      >
        {showProjects ? (
          <div className="flex flex-col gap-0.5">
            <div className="px-2 py-1 text-xs leading-4 text-muted-foreground">
              Choose a project
            </div>
            {projects.length === 0 && <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>}
            {projects.map((project) => (
              <DropdownMenuItem key={project.name} onSelect={() => onProjectSelect?.(project.name)}>
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <FolderIcon className="size-3.5" />
                </span>
                <span className="min-w-0 truncate">{project.name}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <div className="px-2 py-1 text-xs leading-4 text-muted-foreground">Add</div>
              <DropdownMenuItem onSelect={onAttach} disabled={attachDisabled}>
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <PaperclipIcon className="size-3.5" />
                </span>
                <span>Files and images</span>
              </DropdownMenuItem>
            </div>
            {(showGoal || showPlan || onProjectSelect || onSideChat) && (
              <div className="flex flex-col gap-0.5">
                <div className="px-2 py-1 text-xs leading-4 text-muted-foreground">Session</div>
                <div className="flex flex-col gap-px">
                  {onSideChat && (
                    <DropdownMenuItem
                      data-testid="composer-side-chat-action"
                      onSelect={onSideChat}
                      disabled={sideChatDisabled}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <MessagesSquareIcon className="size-3.5" />
                      </span>
                      <span className="shrink-0">{sideChatLabel}</span>
                      <span className="truncate text-xs leading-4 text-muted-foreground">
                        Ask without affecting this conversation
                      </span>
                    </DropdownMenuItem>
                  )}
                  {showGoal && (
                    <DropdownMenuItem
                      disabled={!onGoal || goalDisabled}
                      title={!onGoal ? goalDescription : undefined}
                      data-testid="composer-goal-action"
                      data-active={goalActive || undefined}
                      onSelect={() => {
                        pendingGoalRef.current = true;
                      }}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <TargetIcon className="size-3.5" />
                      </span>
                      <span>Goal</span>
                      <span className="truncate text-xs leading-4 text-muted-foreground">
                        {goalDescription}
                      </span>
                    </DropdownMenuItem>
                  )}
                  {showPlan && (
                    <DropdownMenuItem
                      data-testid="composer-plan-action"
                      data-active={planActive || undefined}
                      aria-label={planLabel}
                      disabled={!onPlan || planDisabled}
                      onSelect={onPlan}
                      title={onPlan ? undefined : "This harness does not support plan mode"}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <LightbulbIcon className="size-3.5" />
                      </span>
                      <span>Plan</span>
                      <span className="truncate text-xs leading-4 text-muted-foreground">
                        {planActive ? "Plan mode is on" : "Turn plan mode on"}
                      </span>
                    </DropdownMenuItem>
                  )}
                  {onProjectSelect && (
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        setShowProjects(true);
                      }}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <FolderIcon className="size-3.5" />
                      </span>
                      <span className="shrink-0">Work in a project</span>
                      <span className="truncate text-xs leading-4 text-muted-foreground">
                        Choose a project for this session
                      </span>
                    </DropdownMenuItem>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
