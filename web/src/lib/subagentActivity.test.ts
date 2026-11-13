// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import {
  readSubagentActivity,
  shortTaskText,
  subagentName,
  subagentTaskDescription,
  subagentMatchesChild,
  sameSubagentDispatch,
  recordedSubagentReturn,
  subagentEventStatus,
  shouldRenderSubagentReply,
} from "./subagentActivity";
import { itemsToBlocks } from "@/lib/itemsToBlocks";

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

it("retains the original dispatch title ahead of steering-derived child summaries", () => {
  expect(
    subagentTaskDescription(
      child({
        task_summary: "Later steering",
        labels: {
          "omnigent.subagent.task_summary": "Original task",
          "omnigent.codex_native.task_name": "Native task",
        },
      }),
    ),
  ).toBe("Original task");
  expect(
    subagentTaskDescription(
      child({
        task_summary: "Later steering",
        labels: { "omnigent.codex_native.task_name": "Native task" },
      }),
    ),
  ).toBe("Native task");
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

it("preserves full dispatch input and result while compacting the task label", () => {
  const activity = readSubagentActivity({
    type: "resource_event",
    resource_type: "session",
    event_type: "session.subagent.returned",
    resource_id: "child",
    resource: {
      dispatch_id: "dispatch-1",
      task_input: "  Original input\n",
      result_text: "  Result\n",
    },
  });
  expect(activity).toMatchObject({
    dispatchId: "dispatch-1",
    taskInput: "  Original input\n",
    resultText: "  Result\n",
  });
  expect(shortTaskText("A long\noriginal task", 10)).toBe("A long or…");
});

function event(
  phase: "delegated" | "returned",
  fields: Record<string, unknown> = {},
  id: string = phase,
) {
  return {
    id,
    response_id: `activity_${id}`,
    status: "completed",
    type: "resource_event",
    resource_type: "session",
    resource_id: "child",
    event_type: `session.subagent.${phase}`,
    resource: { dispatch_id: "dispatch-1", ...fields },
  };
}

it("parses typed identity, creation time, exact input/result references and multipart text", () => {
  expect(
    readSubagentActivity({
      ...event("returned", {
        agent_name: "Ada",
        agent_role: "plugin:reviewer",
        agent_name_source: "native",
        task_input_ref: { conversation_id: "source", item_id: "input" },
        result_ref: { conversation_id: "child", item_id: "first" },
        result_refs: [
          { conversation_id: "child", item_id: "first" },
          { conversation_id: "child", item_id: "second" },
        ],
        result_parts: [
          { conversation_id: "child", item_id: "first", text: "  First\n" },
          { conversation_id: "child", item_id: "second", text: "Second" },
        ],
      }),
      created_at: 123,
    }),
  ).toMatchObject({
    agentName: "Ada",
    agentRole: "plugin:reviewer",
    agentNameSource: "native",
    createdAtS: 123,
    taskInputRef: { conversationId: "source", itemId: "input" },
    resultRef: { conversationId: "child", itemId: "first" },
    resultRefs: [
      { conversationId: "child", itemId: "first" },
      { conversationId: "child", itemId: "second" },
    ],
    resultText: "  First\n\n\nSecond",
    resultParts: [
      { ref: { conversationId: "child", itemId: "first" }, text: "  First\n" },
      { ref: { conversationId: "child", itemId: "second" }, text: "Second" },
    ],
  });
});

it.each([
  42,
  [],
  { conversation_id: 12, item_id: "item" },
  { conversation_id: "child", item_id: "" },
])("ignores malformed references and identity without inventing source data: %j", (value) => {
  expect(
    readSubagentActivity({
      ...event("returned", {
        agent_name: 12,
        agent_role: [],
        agent_name_source: "invented",
        task_input_ref: value,
        result_ref: value,
        result_refs: [value],
        result_parts: [value],
      }),
      created_at: Infinity,
    }),
  ).toMatchObject({
    agentName: null,
    agentRole: null,
    agentNameSource: null,
    taskInputRef: null,
    resultRef: null,
    resultRefs: [],
    resultParts: [],
    createdAtS: undefined,
  });
});

it.each([
  "omnigent.subagent.dispatch_id",
  "omnigent.codex_native.collab_tool_call_id",
  "omnigent.claude_native.tool_use_id",
])("matches only the recorded managed/native/Claude dispatch label %s", (key) => {
  const activity = readSubagentActivity(event("delegated"))!;
  expect(
    subagentMatchesChild(activity, child({ id: "child", labels: { [key]: "dispatch-1" } })),
  ).toBe(true);
  expect(subagentMatchesChild(activity, child({ id: "child", labels: { [key]: "later" } }))).toBe(
    false,
  );
  expect(
    subagentMatchesChild(activity, child({ id: "other", labels: { [key]: "dispatch-1" } })),
  ).toBe(false);
});

it("rejects stale generic dispatch labels when native dispatch identity has changed", () => {
  expect(
    subagentMatchesChild(
      readSubagentActivity(event("delegated"))!,
      child({
        id: "child",
        labels: {
          "omnigent.subagent.dispatch_id": "dispatch-1",
          "omnigent.codex_native.collab_tool_call_id": "later",
        },
      }),
    ),
  ).toBe(false);
});

it("uses exact input references for legacy dispatches, never repeated summaries", () => {
  const delegated = readSubagentActivity(
    event("delegated", { dispatch_id: null, task_summary: "Same title" }),
  )!;
  const returned = readSubagentActivity(
    event("returned", { dispatch_id: null, task_summary: "Same title" }),
  )!;
  expect(sameSubagentDispatch(delegated, returned)).toBe(false);
  const taskInputRef = { conversationId: "child", itemId: "initial-input" };
  expect(sameSubagentDispatch({ ...delegated, taskInputRef }, { ...returned, taskInputRef })).toBe(
    true,
  );
  expect(
    sameSubagentDispatch(
      { ...delegated, dispatchId: "first", taskInputRef },
      { ...returned, dispatchId: "later", taskInputRef },
    ),
  ).toBe(false);
});

it.each(["completed", "failed", "cancelled"])(
  "looks up the exact %s completion after child reuse",
  (status) => {
    const original = readSubagentActivity(event("delegated"))!;
    const blocks = itemsToBlocks([
      event("returned", { status }),
      event("returned", { dispatch_id: "later", status: "failed" }, "later"),
    ]);
    expect(recordedSubagentReturn(original, blocks)?.status).toBe(status);
    expect(subagentEventStatus(recordedSubagentReturn(original, blocks)!)).toMatchObject({
      label: status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Stopped",
    });
    expect(recordedSubagentReturn({ ...original, dispatchId: "missing" }, blocks)).toBeUndefined();
  },
);

it("does not duplicate a report already rendered as an actual native/peer message", () => {
  const returned = event("returned", {
    result_text: "Exact answer",
    result_ref: { conversation_id: "parent", item_id: "native-message" },
  });
  const blocks = itemsToBlocks([
    returned,
    {
      id: "native-message",
      type: "message",
      role: "user",
      status: "completed",
      response_id: "r",
      communication: {
        kind: "native_agent",
        message_id: "real-message",
        destination_conversation_id: "parent",
        source_conversation_id: "child",
        delivery_state: "confirmed",
      },
      content: [{ type: "input_text", text: "Exact answer" }],
    },
  ]);
  expect(shouldRenderSubagentReply(readSubagentActivity(returned)!, blocks, "parent")).toBe(false);
  expect(
    shouldRenderSubagentReply(
      {
        ...readSubagentActivity(returned)!,
        resultRefs: [{ conversationId: "parent", itemId: "missing-part" }],
      },
      blocks,
      "parent",
    ),
  ).toBe(true);
  expect(
    shouldRenderSubagentReply(readSubagentActivity(returned)!, blocks, "other-conversation"),
  ).toBe(true);
});
