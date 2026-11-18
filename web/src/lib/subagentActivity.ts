// Modified for Triune.
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import type { AgentStatus } from "@/shell/subagentStatus";
import { itemPosition } from "./transcriptOrder";
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
  execution?: { model: string; effort: string | null };
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
  turnId: string | null;
  resultFinality: "unknown" | "final_answer" | "adapter_result" | "handback";
  resultRevision: number | null;
  taskInputPosition: number | null;
  resultPosition: number | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function meaningfulTaskSummary(value: unknown): string | null {
  const summary = text(value);
  return summary &&
    summary.length <= 80 &&
    !summary.includes("\n") &&
    !["delegated task", "sub-agent", "subagent", "agent"].includes(summary.toLowerCase())
    ? summary
    : null;
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

export function nativeSubagentName(
  labels?: Readonly<Record<string, unknown>> | null,
): string | null {
  return (
    text(labels?.["omnigent.codex_native.agent_nickname"]) ??
    text(labels?.["omnigent.claude_native.agent_name"])
  );
}

/** Agent identity and task text are separate; native tool labels can contain task text. */
export function subagentName(child: ChildSessionInfo): string {
  const labels = child.labels;
  const title = text(child.title);
  const task = rawSubagentTaskDescription(child);
  const tool = text(child.tool);
  const titleAgent =
    title?.includes(":") && title !== task
      ? title.startsWith("ui:")
        ? title.split(":")[1]
        : title.slice(0, title.lastIndexOf(":"))
      : null;
  return (
    nativeSubagentName(labels) ??
    text(child.agent_name) ??
    text(labels?.["omnigent.codex_native.agent_role"]) ??
    text(labels?.["omnigent.antigravity_native.agent_role"]) ??
    (labels?.["omnigent.claude_native.description"] ? titleAgent : tool !== task ? tool : null) ??
    (!labels?.["omnigent.wrapper"] ? titleAgent : null) ??
    "Agent"
  );
}

function rawSubagentTaskDescription(child: ChildSessionInfo): string | null {
  return (
    meaningfulTaskSummary(child.labels?.["omnigent.subagent.card_summary"]) ??
    meaningfulTaskSummary(child.labels?.["omnigent.subagent.task_summary"]) ??
    meaningfulTaskSummary(child.labels?.["omnigent.codex_native.task_name"]) ??
    meaningfulTaskSummary(child.task_summary) ??
    meaningfulTaskSummary(child.labels?.["omnigent.claude_native.description"])
  );
}

/** Display identifiers as labels without changing saved task input or acronyms. */
export function formatSubagentTask(value: string): string {
  const label = value.trim();
  const words = /^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+$/u.test(label)
    ? label
        .split("_")
        .map((word) => (word === word.toUpperCase() ? word : word.toLowerCase()))
        .join(" ")
    : label;
  return words.replace(/^\p{Ll}/u, (initial) => initial.toUpperCase());
}

export function subagentTaskDescription(child: ChildSessionInfo): string | null {
  const task = rawSubagentTaskDescription(child);
  return task ? formatSubagentTask(task) : null;
}

/** Enrich a captured dispatch only with the same dispatch's authoritative native name. */
export function subagentActivityName(activity: SubagentActivity, child?: ChildSessionInfo): string {
  const recorded = activity.agentName ?? activity.agentRole;
  if (activity.agentNameSource === "native" && activity.agentName) return activity.agentName;
  if (child && subagentMatchesChild(activity, child)) {
    const native = nativeSubagentName(child.labels);
    return native ?? recorded ?? subagentName(child);
  }
  return recorded ?? "Agent";
}

export function subagentEventStatus(activity: SubagentActivity): AgentStatus {
  if (activity.status === "failed") return { activity: "failed", label: "Failed" };
  if (["cancelled", "killed", "stopped"].includes(activity.status ?? ""))
    return { activity: "other", label: "Stopped" };
  if (activity.status === "completed") return { activity: "done", label: "Completed" };
  if (activity.phase === "delegated") return { activity: "other", label: "Status unavailable" };
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
  const execution =
    fields.execution && typeof fields.execution === "object"
      ? (fields.execution as Record<string, unknown>)
      : null;
  const observedModel =
    execution && ["codex_turn_context", "claude_response"].includes(String(execution.source))
      ? text(execution.model)
      : null;
  const resultParts = Array.isArray(fields.result_parts)
    ? fields.result_parts.flatMap((value) => {
        const ref = itemRef(value);
        const content = value && typeof value === "object" ? fullText(value.text) : null;
        return ref && content ? [{ ref, text: content }] : [];
      })
    : [];
  return {
    phase,
    ...(observedModel
      ? { execution: { model: observedModel, effort: text(execution?.effort) } }
      : {}),
    sessionId,
    title: typeof title === "string" && title.trim() ? title : "Sub-agent",
    status: typeof status === "string" ? status : null,
    agentName: text(fields.agent_name),
    taskDescription:
      meaningfulTaskSummary(fields.card_summary) ??
      meaningfulTaskSummary(fields.task_summary) ??
      meaningfulTaskSummary(fields.description),
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
    turnId: text(fields.turn_id),
    resultFinality:
      fields.result_finality === "final_answer" ||
      fields.result_finality === "adapter_result" ||
      fields.result_finality === "handback"
        ? fields.result_finality
        : "unknown",
    resultRevision: itemPosition(fields.result_revision) ?? null,
    taskInputPosition: itemPosition(fields.task_input_position) ?? null,
    resultPosition: itemPosition(fields.result_position) ?? null,
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

/** Native name and current lifecycle belong to the child across steering dispatches. */
export function subagentMatchesChild(activity: SubagentActivity, child: ChildSessionInfo): boolean {
  return activity.sessionId === child.id;
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

const cardCache = new WeakMap<
  Record<string, unknown>,
  {
    sources: Record<string, unknown>[];
    card: Record<string, unknown>;
  }
>();

/** Presentation identity is parent + child; dispatches remain immutable source records. */
export function canonicalSubagentCards(
  blocks: readonly AnyBlock[],
): Map<string, Record<string, unknown>> {
  const groups = new Map<string, { data: Record<string, unknown>; activity: SubagentActivity }[]>();
  for (const block of blocks) {
    if (block.type !== "native_tool" || block.toolType !== "subagent_activity") continue;
    const activity = readSubagentActivity(block.data);
    if (!activity) continue;
    const key = JSON.stringify([block.data.conversation_id ?? null, activity.sessionId]);
    const group = groups.get(key) ?? [];
    group.push({ data: block.data, activity });
    groups.set(key, group);
  }
  const cards = new Map<string, Record<string, unknown>>();
  for (const group of groups.values()) {
    const delegated = group.filter((entry) => entry.activity.phase === "delegated");
    const first = delegated[0] ?? group[0];
    if (!first?.activity.itemId) continue;
    const dispatches = new Map<string, SubagentActivity>();
    let latestDispatch = "";
    for (const { activity } of group) {
      const key =
        activity.dispatchId ?? activity.taskInputRef?.itemId ?? activity.itemId ?? "unknown";
      const previous = dispatches.get(key);
      if (!previous) latestDispatch = key;
      if (previous?.phase !== "returned" || activity.phase === "returned")
        dispatches.set(key, activity);
    }
    const latest = dispatches.get(latestDispatch)!;
    const resource = first.data.resource as Record<string, unknown>;
    const summary = group.find((entry) => entry.activity.taskDescription)?.activity.taskDescription;
    const sources = group.map((entry) => entry.data);
    const cached = cardCache.get(first.data);
    const card =
      cached &&
      cached.sources.length === sources.length &&
      cached.sources.every((source, index) => source === sources[index])
        ? cached.card
        : {
            ...first.data,
            event_type: "session.subagent.delegated",
            resource: {
              ...resource,
              task_summary: summary ?? null,
              card_key: JSON.stringify([
                first.data.conversation_id ?? null,
                first.activity.sessionId,
              ]),
              card_dispatch_id: latestDispatch,
              card_status: latest.status,
              card_phase: latest.phase,
              card_aliases: group.flatMap((entry) =>
                entry.activity.itemId ? [entry.activity.itemId] : [],
              ),
              card_dispatches: sources,
            },
          };
    cardCache.set(first.data, { sources, card });
    cards.set(first.activity.itemId, card);
    for (const entry of group) if (entry.activity.itemId) cards.set(entry.activity.itemId, card);
  }
  return cards;
}

/** Every captured dispatch resolves to the one displayed child card. */
export function subagentCardItemIds(data: Record<string, unknown>): string[] {
  const resource = data.resource as Record<string, unknown> | undefined;
  return Array.isArray(resource?.card_aliases)
    ? resource.card_aliases.filter((value): value is string => typeof value === "string")
    : typeof data.id === "string"
      ? [data.id]
      : [];
}

export interface SubagentCardMessage {
  direction: "Instruction" | "Reply";
  activity: SubagentActivity;
  position: number | null;
  text: string;
}

const finalityRank = { unknown: 0, final_answer: 1, adapter_result: 2, handback: 3 };

/** Reports replace text and exact source references together within one dispatch/turn. */
function replacesReport(previous: SubagentActivity, incoming: SubagentActivity): boolean {
  const rank = finalityRank[incoming.resultFinality];
  const oldRank = finalityRank[previous.resultFinality];
  return (
    rank > oldRank ||
    (rank === oldRank && (incoming.resultRevision ?? 0) > (previous.resultRevision ?? 0))
  );
}

/** Unknown finality and inventory previews never become child-authored replies. */
export function subagentCardMessages(data: Record<string, unknown>): SubagentCardMessage[] {
  const resource = data.resource as Record<string, unknown> | undefined;
  const sources = Array.isArray(resource?.card_dispatches) ? resource.card_dispatches : [data];
  const messages = new Map<string, SubagentCardMessage>();
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const activity = readSubagentActivity(source);
    if (!activity) continue;
    const dispatch =
      activity.dispatchId ??
      (activity.taskInputRef ? JSON.stringify(activity.taskInputRef) : activity.itemId);
    if (activity.taskInput && activity.phase === "delegated") {
      const key = JSON.stringify([
        "instruction",
        activity.sessionId,
        activity.taskInputRef ?? activity.itemId,
      ]);
      if (!messages.has(key))
        messages.set(key, {
          direction: "Instruction",
          activity,
          text: activity.taskInput,
          position:
            activity.taskInputRef?.conversationId === activity.sessionId
              ? activity.taskInputPosition
              : null,
        });
    }
    if (
      activity.resultText &&
      activity.resultFinality !== "unknown" &&
      activity.phase === "returned"
    ) {
      const key = JSON.stringify([
        "reply",
        activity.sessionId,
        dispatch,
        activity.turnId ?? activity.itemId,
      ]);
      const previous = messages.get(key);
      const refs = [
        ...(activity.resultRef ? [activity.resultRef] : []),
        ...activity.resultRefs,
        ...activity.resultParts.map((part) => part.ref),
      ];
      if (!previous || replacesReport(previous.activity, activity))
        messages.set(key, {
          direction: "Reply",
          activity,
          text: activity.resultText,
          // Enrichment changes the snapshot, never the occurrence's order.
          position: previous
            ? previous.position
            : refs.length > 0 && refs.every((ref) => ref.conversationId === activity.sessionId)
              ? activity.resultPosition
              : null,
        });
    }
  }
  return [...messages.values()];
}

/** Only canonical child positions can order exact input and report references. */
export function latestSubagentCardMessage(
  messages: readonly SubagentCardMessage[],
): SubagentCardMessage | undefined {
  let latest: SubagentCardMessage | undefined;
  for (const message of messages) {
    if (
      message.position !== null &&
      (latest?.position == null || message.position > latest.position)
    )
      latest = message;
  }
  // A legacy spawn instruction is proven; capture time does not prove a report is newer.
  return latest ?? messages.find((message) => message.direction === "Instruction");
}
