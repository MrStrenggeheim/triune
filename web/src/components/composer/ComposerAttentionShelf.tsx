// Modified for Triune.
import { useEffect, useMemo, useState } from "react";
import { ListTodoIcon, MessageCircleQuestionMarkIcon, ShieldCheckIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useConversationChatStore } from "@/workbench/ScopedChatStore";
import type { ElicitationBlock } from "@/lib/blocks";
import { castAskUserQuestionPayload, parseAskUserQuestionPreview } from "@/lib/askUserQuestion";
import { ElicitationCard } from "@/components/blocks/ApprovalCard";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TodoPanel } from "@/shell/TodoPanel";
import { ComposerWorkspaceBar } from "./ComposerControls";
import { BackgroundTaskIndicator } from "./BackgroundTaskIndicator";
import { SubagentTaskIndicator } from "./SubagentTaskIndicator";
import { COMPOSER_WORKSPACE_COLLAPSED_LABEL_CLASS } from "./ChatComposer";

export function isQuestionRequest(block: ElicitationBlock): boolean {
  if (block.codexCommand || block.exitPlanMode) return false;
  return (
    Boolean(
      castAskUserQuestionPayload(block.askUserQuestion) ??
      parseAskUserQuestionPreview(block.contentPreview),
    ) || Object.keys(block.requestedSchema.properties ?? {}).length > 0
  );
}

/** Original composer tray, with the existing request forms and task popovers. */
export function ComposerAttentionShelf() {
  const useChatStore = useConversationChatStore();
  const conversationId = useChatStore((state) => state.conversationId);
  const pending = useChatStore(
    useShallow((state) =>
      state.blocks.filter(
        (block): block is ElicitationBlock =>
          block.type === "elicitation" && block.status === "pending",
      ),
    ),
  );
  const todos = useChatStore((state) => state.todos);
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const requests = useMemo(
    () => ({
      questions: pending.filter(isQuestionRequest),
      approvals: pending.filter((block) => !isQuestionRequest(block)),
    }),
    [pending],
  );
  const [open, setOpen] = useState<"questions" | "approvals" | "plan" | null>(null);
  useEffect(() => setOpen(null), [conversationId]);
  useEffect(() => {
    if (open === "plan" ? !todos.length : open && !requests[open].length) setOpen(null);
  }, [open, requests, todos.length]);

  return (
    <ComposerWorkspaceBar
      data-testid="composer-attention-shelf"
      className="shrink-0 gap-1 [&:not(:has(button))]:hidden"
    >
      {(["questions", "approvals"] as const).map((kind) => {
        const items = requests[kind];
        if (!items.length) return null;
        const label = kind === "questions" ? "Questions" : "Approvals";
        const Icon = kind === "questions" ? MessageCircleQuestionMarkIcon : ShieldCheckIcon;
        return (
          <Popover
            key={kind}
            open={open === kind}
            onOpenChange={(value) => setOpen(value ? kind : null)}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="gap-1 px-1 font-normal tabular-nums"
                aria-label={`${label}: ${items.length}`}
              >
                <Icon className="size-3.5 text-warning" />
                <span
                  data-workspace-collapse-label=""
                  className={COMPOSER_WORKSPACE_COLLAPSED_LABEL_CLASS}
                >
                  {label}
                </span>
                <span>{items.length}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              collisionPadding={8}
              className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto p-2"
              aria-label={label}
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <div className="flex flex-col gap-2">
                {items.map((block) => (
                  <ElicitationCard
                    key={block.elicitationId}
                    item={{ ...block, kind: "elicitation", itemId: block.ctx.itemId }}
                    className="rounded-none border-0 p-1 shadow-none"
                  />
                ))}
              </div>
            </PopoverContent>
          </Popover>
        );
      })}
      <span className="flex-1" />
      <BackgroundTaskIndicator shelf />
      <SubagentTaskIndicator conversationId={conversationId} shelf />
      {todos.length > 0 && (
        <Popover open={open === "plan"} onOpenChange={(value) => setOpen(value ? "plan" : null)}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="gap-1 px-1 font-normal tabular-nums"
              aria-label={`Plan: ${completed} of ${todos.length} completed`}
            >
              <ListTodoIcon className="size-3.5" />
              <span
                data-workspace-collapse-label=""
                className={COMPOSER_WORKSPACE_COLLAPSED_LABEL_CLASS}
              >
                Plan
              </span>
              <span>
                {completed}/{todos.length}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            collisionPadding={8}
            className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto p-2"
            aria-label="Plan"
          >
            <TodoPanel frameless />
          </PopoverContent>
        </Popover>
      )}
    </ComposerWorkspaceBar>
  );
}
