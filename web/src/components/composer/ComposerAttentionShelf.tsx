// Modified for Triune.
import { useEffect, useMemo, useRef, useState } from "react";
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
import { ComposerShelf } from "./ComposerShelf";
import { useChildSessions } from "@/hooks/useChildSessions";
import { childStatus } from "@/shell/subagentStatus";
import { useComposerShelfVisibility } from "./ComposerShelfVisibility";
import { GoalStatusPill } from "@/components/goal";
import type { Goal } from "@/lib/goalApi";

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
export function ComposerAttentionShelf({
  goal = null,
  onOpenGoal,
}: {
  goal?: Goal | null;
  onOpenGoal?: () => void;
}) {
  const useChatStore = useConversationChatStore();
  const conversationId = useChatStore((state) => state.conversationId);
  const backgroundCount = useChatStore((state) => state.backgroundTaskCount);
  const { children } = useChildSessions(conversationId);
  const hasAgents = children.some((child) =>
    ["launching", "working", "awaiting", "disconnected", "failed"].includes(
      childStatus(child).activity,
    ),
  );
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
  const { visible, planRequest } = useComposerShelfVisibility({
    conversationId,
    active:
      goal?.status === "active" ||
      pending.length > 0 ||
      completed < todos.length ||
      backgroundCount > 0 ||
      children.some((child) =>
        ["launching", "working", "awaiting", "disconnected"].includes(childStatus(child).activity),
      ),
    hasContent:
      pending.length > 0 || todos.length > 0 || backgroundCount > 0 || hasAgents || goal !== null,
    hasPlan: todos.length > 0,
    requiredIds: pending.map(
      (block) => `${block.targetSessionId ?? conversationId}:${block.elicitationId}`,
    ),
  });
  const requests = useMemo(
    () => ({
      questions: [
        ...new Map(
          pending
            .filter(isQuestionRequest)
            .map((block) => [
              `${block.targetSessionId ?? conversationId}:${block.elicitationId}`,
              block,
            ]),
        ).values(),
      ],
      approvals: pending.filter((block) => !isQuestionRequest(block)),
    }),
    [pending, conversationId],
  );
  const [open, setOpen] = useState<"questions" | "approvals" | "plan" | null>(null);
  const lastPlanRequest = useRef(0);
  useEffect(() => {
    if (planRequest === lastPlanRequest.current) return;
    lastPlanRequest.current = planRequest;
    if (planRequest > 0 && todos.length > 0) setOpen("plan");
  }, [planRequest, todos.length]);
  useEffect(() => {
    if (!visible) setOpen(null);
  }, [visible]);
  const [mountedRequests, setMountedRequests] = useState({
    conversationId,
    questions: false,
    approvals: false,
  });
  const requestTriggers = useRef<Partial<Record<"questions" | "approvals", HTMLButtonElement>>>({});
  useEffect(() => setOpen(null), [conversationId]);
  useEffect(() => {
    if (open === "plan" ? !todos.length : open && !requests[open].length) setOpen(null);
  }, [open, requests, todos.length]);

  return (
    <ComposerShelf
      key={conversationId}
      retainContent={false}
      present={visible}
      keepMounted={
        pending.length > 0 || todos.length > 0 || backgroundCount > 0 || hasAgents || goal !== null
      }
    >
      <ComposerWorkspaceBar
        shelfInset
        data-testid="composer-attention-shelf"
        className="composer-attention-surface shrink-0 gap-1"
      >
        {(["questions", "approvals"] as const).map((kind) => {
          const items = requests[kind];
          if (!items.length) return null;
          const label = kind === "questions" ? "Questions" : "Approvals";
          const Icon = kind === "questions" ? MessageCircleQuestionMarkIcon : ShieldCheckIcon;
          return (
            <Popover
              key={kind}
              modal={false}
              open={open === kind}
              onOpenChange={(value) => {
                if (value)
                  setMountedRequests((current) => ({
                    ...(current.conversationId === conversationId
                      ? current
                      : { conversationId, questions: false, approvals: false }),
                    [kind]: true,
                  }));
                setOpen((current) => (value ? kind : current === kind ? null : current));
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  ref={(node) => {
                    if (node) requestTriggers.current[kind] = node;
                  }}
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
              {mountedRequests.conversationId === conversationId && mountedRequests[kind] && (
                <PopoverContent
                  forceMount
                  hidden={open !== kind}
                  aria-hidden={open !== kind || undefined}
                  style={{
                    ...(open !== kind ? { display: "none" } : {}),
                  }}
                  side="top"
                  align="start"
                  collisionPadding={8}
                  className={`max-h-[min(24rem,var(--radix-popover-content-available-height))] ${kind === "questions" ? "w-[min(30rem,calc(100vw-2rem))]" : "w-[min(25rem,calc(100vw-2rem))]"} overflow-y-auto p-2`}
                  aria-label={label}
                  onOpenAutoFocus={(event) => event.preventDefault()}
                  onEscapeKeyDown={() => {
                    if (open === "questions" || open === "approvals")
                      requestTriggers.current[open]?.focus();
                    setOpen(null);
                  }}
                >
                  {kind === "questions" ? (
                    <QuestionRequests items={items} />
                  ) : (
                    <div className="flex flex-col gap-2">
                      {items.map((block) => (
                        <ElicitationCard
                          key={block.elicitationId}
                          item={{ ...block, kind: "elicitation", itemId: block.ctx.itemId }}
                          className="rounded-none border-0 p-1 shadow-none"
                        />
                      ))}
                    </div>
                  )}
                </PopoverContent>
              )}
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
        {goal && <GoalStatusPill goal={goal} onOpen={onOpenGoal} />}
      </ComposerWorkspaceBar>
    </ComposerShelf>
  );
}

/** One selector entry per real batch; only its current question is presented. */
function QuestionRequests({ items }: { items: ElicitationBlock[] }) {
  const [selected, setSelected] = useState(items[0]?.elicitationId);
  const [visited, setVisited] = useState(() => new Set([items[0]?.elicitationId]));
  const active =
    items.find((item) => item.elicitationId === selected)?.elicitationId ?? items[0]?.elicitationId;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {items.length > 1 && (
        <nav aria-label="Question batches" className="flex flex-wrap gap-1">
          {items.map((block, index) => (
            <Button
              key={block.elicitationId}
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Question batch ${index + 1} of ${items.length}`}
              aria-pressed={block.elicitationId === active}
              onClick={() => {
                setSelected(block.elicitationId);
                setVisited((current) => new Set(current).add(block.elicitationId));
              }}
            >
              {index + 1}
            </Button>
          ))}
        </nav>
      )}
      {items
        .filter((block) => block.elicitationId === active || visited.has(block.elicitationId))
        .map((block) => (
          <div key={block.elicitationId} hidden={block.elicitationId !== active}>
            <ElicitationCard
              item={{ ...block, kind: "elicitation", itemId: block.ctx.itemId }}
              questionPresentation="popup"
            />
          </div>
        ))}
    </div>
  );
}
