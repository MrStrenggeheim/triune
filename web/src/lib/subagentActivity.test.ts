// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { readSubagentActivity, subagentName, subagentTaskDescription } from "./subagentActivity";

const child = (fields: Partial<ChildSessionInfo>): ChildSessionInfo => ({
  id: "opaque-uuid",
  title: null,
  tool: null,
  task_summary: null,
  session_name: null,
  current_task_status: null,
  busy: false,
  pending_elicitations_count: 0,
  last_message_preview: null,
  ...fields,
});

it("keeps real Codex nicknames ahead of role, tool and task-derived labels", () => {
  expect(
    subagentName(
      child({
        tool: "reviewer",
        task_summary: "Inspect navigation",
        labels: {
          "omnigent.codex_native.agent_nickname": "James",
          "omnigent.codex_native.agent_role": "worker",
        },
      }),
    ),
  ).toBe("James");
});

it("separates a namespaced Claude agent identity from its recorded task description", () => {
  const agent = child({
    title: "plugin:reviewer:opaque-id",
    tool: "Inspect navigation",
    labels: { "omnigent.claude_native.description": "Inspect navigation" },
  });
  expect(subagentName(agent)).toBe("plugin:reviewer");
  expect(subagentTaskDescription(agent)).toBe("Inspect navigation");
});

it.each([
  {},
  { title: "Inspect navigation", tool: "Inspect navigation", task_summary: "Inspect navigation" },
  { title: "opaque-uuid" },
])("uses an honest unknown identity for %j", (fields) => {
  expect(subagentName(child(fields))).toBe("Agent");
});

it("uses recorded Codex instructions rather than message previews as task text", () => {
  expect(subagentTaskDescription(child({ last_message_preview: "It looks finished" }))).toBeNull();
  expect(
    subagentTaskDescription(
      child({ labels: { "omnigent.codex_native.prompt": "Check navigation" } }),
    ),
  ).toBe("Check navigation");
});

it("does not interpret an ambiguous legacy event title as an agent or task description", () => {
  expect(
    readSubagentActivity({
      type: "resource_event",
      resource_type: "session",
      event_type: "session.subagent.delegated",
      resource_id: "child",
      resource: { title: "Some old label" },
    }),
  ).toMatchObject({ agentName: null, taskDescription: null });
});
