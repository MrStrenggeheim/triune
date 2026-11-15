// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import {
  questionAnswer,
  questionBatchFromItem,
  questionReceiptBlock,
  reconcileQuestionBatches,
  isQuestionSubmissionEcho,
} from "./questionBatches";
import type { ElicitationBlock } from "./blocks";

const item = {
  id: "receipt-item",
  type: "resource_event",
  response_id: "submission",
  resource_type: "question_batch",
  event_type: "session.question.answered",
  resource_id: "ask",
  resource: {
    version: 1,
    session_id: "chat",
    elicitation_id: "ask",
    submission_id: "submitted",
    action: "accept",
    questions: [
      { id: "q0", question: "Same?", answered: true, answer: "", header: "Scope" },
      { id: "q1", question: "Same?", answered: false },
    ],
  },
};
it("maps stable keys, explicit empty and missing answers without fabricating headers", () => {
  const block = questionReceiptBlock(item)!;
  expect(block.elicitationId).toBe("ask");
  expect(block.response?.content).toEqual({ q0: "" });
  expect(block.askUserQuestion?.questions).toEqual([
    { id: "q0", question: "Same?", header: "Scope", options: [], multiSelect: false },
    { id: "q1", question: "Same?", options: [], multiSelect: false },
  ]);
  expect(
    questionAnswer(
      { id: "q0", question: "Same?", options: [], multiSelect: false },
      block.response?.content,
    ),
  ).toBe("");
  expect(
    questionAnswer(
      { id: "q1", question: "Same?", options: [], multiSelect: false },
      block.response?.content,
    ),
  ).toBeUndefined();
});
it("transforms the pending batch at its original position and consumes the receipt once", () => {
  const receipt = questionReceiptBlock(item)!;
  const pending: ElicitationBlock = {
    ...receipt,
    status: "pending",
    response: null,
    ctx: { ...receipt.ctx, itemId: "original", responseId: "original-turn" },
  };
  const blocks = reconcileQuestionBatches([pending, receipt, receipt], "chat");
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    status: "responded",
    ctx: pending.ctx,
    response: { content: { q0: "" } },
  });
  const other = { ...receipt, elicitationId: "another-batch" };
  expect(reconcileQuestionBatches([pending, receipt, other], "chat")).toHaveLength(2);
});
it("correlates native echoes only through all three trusted identity fields", () => {
  const receipt = questionBatchFromItem(item)!;
  const identity = { session_id: "chat", elicitation_id: "ask", submission_id: "submitted" };
  expect(isQuestionSubmissionEcho({ question_submission: identity }, [receipt])).toBe(true);
  expect(
    isQuestionSubmissionEcho({ communication: { question_submission: identity } }, [receipt]),
  ).toBe(true);
  expect(
    isQuestionSubmissionEcho({ question_submission: { ...identity, session_id: "other" } }, [
      receipt,
    ]),
  ).toBe(false);
  expect(
    isQuestionSubmissionEcho({ question_submission: { ...identity, submission_id: "other" } }, [
      receipt,
    ]),
  ).toBe(false);
  expect(isQuestionSubmissionEcho({ content: [{ text: "Same?\n" }] }, [receipt])).toBe(false);
});
it("retains redacted answered state without accepting leaked secret answer bytes", () => {
  const resource = {
    ...item.resource,
    questions: [{ id: "secret", question: "Token?", answered: true, redacted: true }],
  };
  const block = questionReceiptBlock({ ...item, resource })!;
  expect(block.response?.content).toEqual({});
  expect(block.response?.["_meta"]?.redacted_questions).toEqual(["secret"]);
  expect(block.askUserQuestion?.questions).toEqual([
    { id: "secret", question: "Token?", options: [], multiSelect: false, isSecret: true },
  ]);
  expect(
    questionReceiptBlock({
      ...item,
      resource: { ...resource, questions: [{ ...resource.questions[0], answer: "DO-NOT-RETAIN" }] },
    }),
  ).toBeNull();
});
it("does not reinterpret arbitrary resource events or malformed receipts", () => {
  expect(questionReceiptBlock({ ...item, resource_type: "session" })).toBeNull();
  expect(
    questionReceiptBlock({ ...item, resource: { ...item.resource, questions: [] } }),
  ).toBeNull();
});

it("covers legacy Claude reconstruction only with a trusted call ID in the same session", async () => {
  const { receiptCoversQuestionCall } = await import("./questionBatches");
  const receipt = { ...questionBatchFromItem(item)!, source: { tool_use_id: "call-1" } };
  const call = {
    type: "function_call",
    name: "AskUserQuestion",
    call_id: "call-1",
    arguments: "Same?",
  };
  expect(receiptCoversQuestionCall(call, [receipt], "chat")).toBe(true);
  expect(receiptCoversQuestionCall({ ...call, call_id: "call-2" }, [receipt], "chat")).toBe(false);
  expect(receiptCoversQuestionCall(call, [receipt], "other")).toBe(false);
  expect(receiptCoversQuestionCall(call, [questionBatchFromItem(item)!], "chat")).toBe(false);
});

it("retains two canonical submissions when a provider reuses its elicitation ID", () => {
  const first = questionReceiptBlock(item)!;
  const second = questionReceiptBlock({
    ...item,
    id: "second",
    resource: { ...item.resource, submission_id: "second-submission" },
  })!;
  expect(reconcileQuestionBatches([first, second], "chat")).toHaveLength(2);
});
