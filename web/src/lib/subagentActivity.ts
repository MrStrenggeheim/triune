// Modified for Triune.
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import type { AgentStatus } from "@/shell/subagentStatus";
import type { AnyBlock } from "@/lib/blocks";

export interface SubagentItemRef {
  conversationId: string;
  itemId: string;
}

export interface SubagentResultPart {
  text: string;
  ref: SubagentItemRef;
}

export interface SubagentActivity {
  phase: "delegated" | "returned";
  sessionId: string;
  title: string;
  status: string | null;
  agentName: string | null;
  taskDescription: string | null;
  dispatchId: string | null;
  taskInput: string | null;
  resultText: string | null;
  itemId: string | null;
  createdAtS: number | undefined;
  agentRole: string | null;
  agentNameSource: "native" | "role" | "unknown" | null;
  taskInputRef: SubagentItemRef | null;
  resultRef: SubagentItemRef | null;
  resultRefs: SubagentItemRef[];
  resultParts: SubagentResultPart[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fullText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function itemRef(value: unknown): SubagentItemRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const conversationId = text(fields.conversation_id);
  const itemId = text(fields.item_id);
  return conversationId && itemId ? { conversationId, itemId } : null;
}

/** Agent identity and task text are separate; native tool labels can contain task text. */
export function subagentName(child: ChildSessionInfo): string {
  const labels = child.labels;
  const title = text(child.title);
  const task = subagentTaskDescription(child);
  const tool = text(child.tool);
  const titleAgent =
    title?.includes(":") && title !== task
      ? title.startsWith("ui:")
        ? title.split(":")[1]
        : title.slice(0, title.lastIndexOf(":"))
      : null;
  return (
    text(labels?.["omnigent.codex_native.agent_nickname"]) ??
    text(labels?.["omnigent.claude_native.agent_name"]) ??
    text(child.agent_name) ??
    text(labels?.["omnigent.codex_native.agent_role"]) ??
    text(labels?.["omnigent.antigravity_native.agent_role"]) ??
    (labels?.["omnigent.claude_native.description"] ? titleAgent : tool !== task ? tool : null) ??
    (!labels?.["omnigent.wrapper"] ? titleAgent : null) ??
    "Agent"
  );
}

export function subagentTaskDescription(child: ChildSessionInfo): string | null {
  return (
    text(child.labels?.["omnigent.subagent.task_summary"]) ??
    text(child.labels?.["omnigent.codex_native.task_name"]) ??
    text(child.task_summary) ??
    text(child.labels?.["omnigent.claude_native.description"]) ??
    text(child.labels?.["omnigent.codex_native.prompt"]) ??
    text(child.labels?.["omnigent.claude_native.prompt"])
  );
}

export function subagentEventStatus(activity: SubagentActivity): AgentStatus {
  if (activity.status === "failed") return { activity: "failed", label: "Failed" };
  if (["cancelled", "killed", "stopped"].includes(activity.status ?? ""))
    return { activity: "other", label: "Stopped" };
  if (activity.status === "completed") return { activity: "done", label: "Completed" };
  if (activity.phase === "delegated") return { activity: "other", label: "Started" };
  return { activity: "done", label: "Completed" };
}

/** Read display-only child lifecycle metadata from a persisted resource event. */
export function readSubagentActivity(item: Record<string, unknown>): SubagentActivity | null {
  if (item.type !== "resource_event" || item.resource_type !== "session") return null;
  const phase =
    item.event_type === "session.subagent.delegated"
      ? "delegated"
      : item.event_type === "session.subagent.returned"
        ? "returned"
        : null;
  const sessionId = text(item.resource_id);
  if (!phase || !sessionId) return null;
  const resource = item.resource;
  const fields =
    resource && typeof resource === "object" && !Array.isArray(resource)
      ? (resource as Record<string, unknown>)
      : {};
  const title = fields.title;
  const status = fields.status;
  const resultParts = Array.isArray(fields.result_parts)
    ? fields.result_parts.flatMap((value) => {
        const ref = itemRef(value);
        const content = value && typeof value === "object" ? fullText(value.text) : null;
        return ref && content ? [{ ref, text: content }] : [];
      })
    : [];
  return {
    phase,
    sessionId,
    title: typeof title === "string" && title.trim() ? title : "Sub-agent",
    status: typeof status === "string" ? status : null,
    agentName: text(fields.agent_name),
    taskDescription: text(fields.task_summary) ?? text(fields.description),
    dispatchId: text(fields.dispatch_id),
    taskInput: fullText(fields.task_input),
    resultText:
      fullText(fields.result_text) ??
      (resultParts.length ? resultParts.map((part) => part.text).join("\n\n") : null),
    itemId: text(item.id),
    createdAtS:
      typeof item.created_at === "number" && Number.isFinite(item.created_at)
        ? item.created_at
        : undefined,
    agentRole: text(fields.agent_role),
    agentNameSource:
      fields.agent_name_source === "native" ||
      fields.agent_name_source === "role" ||
      fields.agent_name_source === "unknown"
        ? fields.agent_name_source
        : null,
    taskInputRef: itemRef(fields.task_input_ref),
    resultRef: itemRef(fields.result_ref) ?? resultParts[0]?.ref ?? null,
    resultRefs: Array.isArray(fields.result_refs)
      ? fields.result_refs.flatMap((value) => {
          const ref = itemRef(value);
          return ref ? [ref] : [];
        })
      : [],
    resultParts,
  };
}

/** Descriptions can repeat across dispatches; only recorded identifiers prove a match. */
export function sameSubagentDispatch(first: SubagentActivity, second: SubagentActivity): boolean {
  if (first.sessionId !== second.sessionId) return false;
  if (first.dispatchId || second.dispatchId)
    return !!first.dispatchId && first.dispatchId === second.dispatchId;
  return !!(
    first.taskInputRef &&
    second.taskInputRef &&
    first.taskInputRef.conversationId === second.taskInputRef.conversationId &&
    first.taskInputRef.itemId === second.taskInputRef.itemId
  );
}

export function subagentMatchesChild(activity: SubagentActivity, child: ChildSessionInfo): boolean {
  const dispatches = [
    child.labels?.["omnigent.subagent.dispatch_id"],
    child.labels?.["omnigent.codex_native.collab_tool_call_id"],
    child.labels?.["omnigent.claude_native.tool_use_id"],
  ].filter(Boolean);
  return (
    activity.sessionId === child.id &&
    !!activity.dispatchId &&
    dispatches.length > 0 &&
    dispatches.every((dispatch) => dispatch === activity.dispatchId)
  );
}

export function recordedSubagentReturn(
  activity: SubagentActivity,
  blocks: readonly AnyBlock[],
): SubagentActivity | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block?.type !== "native_tool" || block.toolType !== "subagent_activity") continue;
    const candidate = readSubagentActivity(block.data);
    if (candidate?.phase === "returned" && sameSubagentDispatch(activity, candidate))
      return candidate;
  }
  return undefined;
}

/** Keep one answer per dispatch, respecting any actual communication already in the transcript. */
export function shouldRenderSubagentReply(
  activity: SubagentActivity,
  blocks: readonly AnyBlock[],
  conversationId: string | null,
): boolean {
  if (activity.phase !== "returned" || !activity.resultText) return false;
  const refs = [
    ...(activity.resultRef ? [activity.resultRef] : []),
    ...activity.resultRefs,
    ...activity.resultParts.map((part) => part.ref),
  ];
  if (
    refs.length > 0 &&
    refs.every(
      (ref) =>
        ref.conversationId === conversationId &&
        blocks.some(
          (block) =>
            block.type === "user_message" &&
            !!block.communication &&
            block.ctx.itemId === ref.itemId,
        ),
    )
  )
    return false;
  for (const block of blocks) {
    if (block.type !== "native_tool" || block.toolType !== "subagent_activity") continue;
    const candidate = readSubagentActivity(block.data);
    if (
      candidate?.phase === "returned" &&
      candidate.resultText &&
      sameSubagentDispatch(activity, candidate)
    )
      return !activity.itemId || !candidate.itemId || candidate.itemId === activity.itemId;
  }
  return true;
}

export function shortTaskText(value: string, limit = 120): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}
