// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { agentPresentation } from "./agentPresentation";

const child = (fields: Partial<ChildSessionInfo> = {}): ChildSessionInfo => ({
  id: "child",
  title: "Full task title",
  task_summary: "Inspect navigation",
  tool: "codex-native-ui",
  session_name: "task",
  labels: {
    "omnigent.wrapper": "codex-native-ui-subagent",
    "omnigent.codex_native.agent_nickname": "Curie",
  },
  busy: false,
  current_task_status: "completed",
  pending_elicitations_count: 0,
  last_message_preview: "Reply: Latest report",
  ...fields,
});
it("keeps chat title, assigned native nickname and task in their distinct roles", () => {
  expect(
    agentPresentation({
      session: { title: "Main planning", agentName: "codex-native-ui" },
      recordedName: "codex-native-ui",
    }).name,
  ).toBe("Main planning");
  expect(
    agentPresentation({
      child: child(),
      session: { title: "Full task title", agentName: "codex-native-ui" },
    }),
  ).toEqual({ name: "Curie", task: "Inspect navigation", preview: "Reply: Latest report" });
});
it("lets current generated task/name metadata replace captured names and task labels", () => {
  const display = agentPresentation({
    child: child({
      labels: {
        "omnigent.codex_native.agent_nickname": "Boole",
        "omnigent.subagent.card_summary": "Review keyboard focus",
      },
    }),
    recordedName: "codex-native-ui",
  });
  expect(display).toEqual({
    name: "Boole",
    task: "Review keyboard focus",
    preview: "Reply: Latest report",
  });
});
it("removes all cached presentation values after access is denied", () => {
  expect(agentPresentation({ denied: true, child: child(), recordedName: "Private" })).toEqual({
    name: "Agent",
    task: null,
    preview: null,
  });
});
it("uses proven Instruction/Reply positions without promoting unknown finality", () => {
  const entry = (id: string, phase: string, resource: Record<string, unknown>) => ({
    id,
    type: "resource_event",
    resource_id: "child",
    event_type: `session.subagent.${phase}`,
    resource_type: "session",
    resource: { dispatch_id: "dispatch", task_summary: "Inspect navigation", ...resource },
  });
  const instruction = entry("input", "delegated", {
    task_input: "Actual instruction",
    task_input_ref: { conversation_id: "child", item_id: "input" },
    task_input_position: 2,
  });
  const reply = entry("reply", "returned", {
    result_text: "Actual report",
    result_ref: { conversation_id: "child", item_id: "reply" },
    result_position: 3,
    result_finality: "final_answer",
  });
  const data = {
    ...instruction,
    resource: { ...instruction.resource, card_dispatches: [instruction, reply] },
  };
  expect(agentPresentation({ data }).preview).toBe("Reply: Actual report");
  (reply.resource as Record<string, unknown>).result_finality = "unknown";
  expect(agentPresentation({ data }).preview).toBe("Instruction: Actual instruction");
});
