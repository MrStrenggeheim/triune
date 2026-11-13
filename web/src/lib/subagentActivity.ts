// Modified for Triune.
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import type { AgentStatus } from "@/shell/subagentStatus";

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
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fullText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
    text(child.task_summary) ??
    text(child.labels?.["omnigent.claude_native.description"]) ??
    text(child.labels?.["omnigent.codex_native.prompt"]) ??
    text(child.labels?.["omnigent.claude_native.prompt"])
  );
}

export function subagentEventStatus(activity: SubagentActivity): AgentStatus {
  if (activity.phase === "delegated") return { activity: "other", label: "Started" };
  if (activity.status === "failed") return { activity: "failed", label: "Failed" };
  if (["cancelled", "killed", "stopped"].includes(activity.status ?? ""))
    return { activity: "other", label: "Stopped" };
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
  if (!phase || typeof item.resource_id !== "string" || !item.resource_id) return null;
  const resource = item.resource;
  const fields =
    resource && typeof resource === "object" ? (resource as Record<string, unknown>) : {};
  const title =
    resource && typeof resource === "object" && "title" in resource ? resource.title : null;
  const status =
    resource && typeof resource === "object" && "status" in resource ? resource.status : null;
  return {
    phase,
    sessionId: item.resource_id,
    title: typeof title === "string" && title.trim() ? title : "Sub-agent",
    status: typeof status === "string" ? status : null,
    agentName: text(fields.agent_name),
    taskDescription: text(fields.task_summary) ?? text(fields.description),
    dispatchId: text(fields.dispatch_id),
    taskInput: fullText(fields.task_input),
    resultText: fullText(fields.result_text),
  };
}

export function shortTaskText(value: string, limit = 120): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}
