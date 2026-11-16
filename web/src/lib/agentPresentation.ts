// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import type { Session } from "./types";
import {
  formatSubagentTask,
  meaningfulTaskSummary,
  nativeSubagentName,
  subagentName,
  subagentTaskDescription,
  readSubagentActivity,
  subagentCardMessages,
  latestSubagentCardMessage,
  shortTaskText,
  type SubagentActivity,
} from "./subagentActivity";

export type AgentSessionMetadata = Partial<
  Pick<Session, "title" | "subAgentName" | "agentName" | "labels" | "parentSessionId">
>;
export interface AgentPresentationInput {
  session?: AgentSessionMetadata;
  child?: ChildSessionInfo;
  data?: Record<string, unknown>;
  activity?: SubagentActivity;
  recordedName?: string | null;
  recordedTitle?: string | null;
  denied?: boolean;
}
const clean = (value: string | null | undefined) => value?.trim() || null;

/** IDs and provenance select records before this resolver; text never establishes identity. */
export function agentPresentation(input: AgentPresentationInput) {
  if (input.denied) return { name: "Agent", task: null, preview: null };
  const { session, child, data } = input;
  const activity = input.activity ?? (data ? readSubagentActivity(data) : null);
  const nativeName = nativeSubagentName(child?.labels) ?? nativeSubagentName(session?.labels);
  const native =
    !!nativeName ||
    (child?.labels?.["omnigent.wrapper"] ?? session?.labels?.["omnigent.wrapper"])?.endsWith(
      "-native-ui-subagent",
    ) === true;
  const name =
    nativeName ??
    (!native
      ? (clean(session?.title) ?? (!child && !activity ? clean(input.recordedTitle) : null))
      : null) ??
    clean(child?.agent_name) ??
    clean(session?.subAgentName) ??
    (activity?.agentNameSource === "native" ? clean(activity.agentName) : null) ??
    (child ? subagentName(child) : null) ??
    clean(input.recordedName) ??
    clean(activity?.agentName) ??
    clean(session?.agentName) ??
    "Agent";
  const summary =
    meaningfulTaskSummary(child?.labels?.["omnigent.subagent.card_summary"]) ??
    (child ? subagentTaskDescription(child) : null) ??
    meaningfulTaskSummary(session?.labels?.["omnigent.subagent.card_summary"]) ??
    meaningfulTaskSummary(session?.labels?.["omnigent.subagent.task_summary"]) ??
    meaningfulTaskSummary(session?.labels?.["omnigent.codex_native.task_name"]) ??
    meaningfulTaskSummary(activity?.taskDescription);
  const latest = data ? latestSubagentCardMessage(subagentCardMessages(data)) : undefined;
  const preview = latest
    ? shortTaskText(`${latest.direction}: ${latest.text}`, 180)
    : clean(child?.last_message_preview)
      ? shortTaskText(child!.last_message_preview!, 180)
      : activity?.taskInput
        ? shortTaskText(`Instruction: ${activity.taskInput}`, 180)
        : null;
  return { name, task: summary ? formatSubagentTask(summary) : null, preview };
}
