// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ClaudeQuestion } from "./askUserQuestion";
import type { AnyBlock, BlockContext, ElicitationBlock } from "./blocks";

export type QuestionAnswer = string | string[];
export interface QuestionReceipt {
  version: 1;
  session_id: string;
  elicitation_id: string;
  submission_id: string;
  action: "accept" | "decline" | "cancel";
  questions: {
    id: string;
    question: string;
    header?: string;
    answered: boolean;
    redacted?: boolean;
    answer?: QuestionAnswer;
  }[];
  source?: Record<string, unknown>;
  request?: Record<string, unknown>;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function isAnswer(value: unknown): value is QuestionAnswer {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

/** Resolve only the original stable key, with the original-text legacy fallback. */
export function questionAnswer(
  question: ClaudeQuestion,
  answers?: Record<string, unknown>,
): QuestionAnswer | undefined {
  if (!answers) return undefined;
  const key = question.id || question.question;
  const value = Object.hasOwn(answers, key) ? answers[key] : answers[question.question];
  return isAnswer(value) ? value : undefined;
}

/** Only the server's question_batch resource format is a canonical receipt. */
export function questionBatchFromItem(value: unknown): QuestionReceipt | null {
  const item = object(value);
  if (
    item?.type !== "resource_event" ||
    item.resource_type !== "question_batch" ||
    item.event_type !== "session.question.answered"
  )
    return null;
  const receipt = object(item.resource);
  if (
    !receipt ||
    receipt.version !== 1 ||
    typeof receipt.session_id !== "string" ||
    typeof receipt.elicitation_id !== "string" ||
    typeof receipt.submission_id !== "string" ||
    !["accept", "decline", "cancel"].includes(String(receipt.action)) ||
    !Array.isArray(receipt.questions) ||
    !receipt.questions.length
  )
    return null;
  if (
    !receipt.questions.every((raw) => {
      const question = object(raw);
      return (
        question &&
        typeof question.id === "string" &&
        typeof question.question === "string" &&
        typeof question.answered === "boolean" &&
        (!question.answered || question.redacted === true || isAnswer(question.answer)) &&
        (question.redacted !== true || question.answer === undefined) &&
        (question.header === undefined || typeof question.header === "string")
      );
    })
  )
    return null;
  return receipt as unknown as QuestionReceipt;
}

/** Use in both persisted-item hydration and live output_item.done translation. */
export function questionReceiptBlock(
  value: unknown,
  context?: BlockContext,
): ElicitationBlock | null {
  const receipt = questionBatchFromItem(value);
  const item = object(value);
  if (!receipt || !item) return null;
  const content = Object.fromEntries(
    receipt.questions
      .filter((question) => question.answered && !question.redacted)
      .map((question) => [question.id, question.answer]),
  );
  return {
    type: "elicitation",
    ctx: context ?? {
      agent: null,
      depth: 0,
      turn: 0,
      timestamp: 0,
      responseId: String(item.response_id || `elicitation:${receipt.elicitation_id}`),
      itemId: typeof item.id === "string" ? item.id : null,
      ...(typeof item.created_at === "number" ? { createdAtS: item.created_at } : {}),
    },
    elicitationId: receipt.elicitation_id,
    targetSessionId: receipt.session_id,
    message: "",
    phase: "question_receipt",
    policyName: "",
    contentPreview: "",
    requestedSchema: {},
    status: "responded",
    response: {
      action: receipt.action,
      content,
      _meta: {
        redacted_questions: receipt.questions
          .filter((question) => question.answered && question.redacted)
          .map((question) => question.id),
        question_submission: {
          ...receipt.source,
          session_id: receipt.session_id,
          elicitation_id: receipt.elicitation_id,
          submission_id: receipt.submission_id,
        },
      },
    },
    askUserQuestion: {
      questions: receipt.questions.map((question) => ({
        id: question.id,
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        options: [],
        multiSelect: Array.isArray(question.answer),
        ...(question.redacted ? { isSecret: true } : {}),
      })),
    },
  };
}

/** Replace the matching pending card at its original position, preserving its context/key. */
export function reconcileQuestionBatches(blocks: AnyBlock[], sessionId: string): AnyBlock[] {
  const receipts = new Map<string, ElicitationBlock>();
  const submission = (block: ElicitationBlock) =>
    object(block.response?.["_meta"]?.question_submission);
  const batchKey = (block: ElicitationBlock) =>
    `${block.targetSessionId ?? sessionId}:${block.elicitationId}`;
  for (const block of blocks)
    if (block.type === "elicitation" && typeof submission(block)?.submission_id === "string")
      receipts.set(batchKey(block), block);
  const frameworkInputs = new Set(
    [...receipts.values()].flatMap((block) => {
      const identity = submission(block);
      return typeof identity?.framework_input_id === "string" && identity.framework_input_id
        ? [JSON.stringify([identity.session_id, identity.framework_input_id])]
        : [];
    }),
  );
  const shown = new Set<string>();
  return blocks.flatMap<AnyBlock>((block) => {
    if (
      block.type === "user_message" &&
      block.communication?.kind === "system" &&
      frameworkInputs.has(
        JSON.stringify([
          block.communication.destination_conversation_id,
          block.communication.message_id,
        ]),
      )
    )
      return [];
    if (block.type !== "elicitation") return [block];
    const receipt = submission(block) ? block : receipts.get(batchKey(block));
    if (!receipt) return [block];
    const key = JSON.stringify([batchKey(receipt), submission(receipt)?.submission_id]);
    if (shown.has(key)) return [];
    shown.add(key);
    return [{ ...receipt, ctx: block.ctx }];
  });
}

/** Suppress an echo only when its trusted native submission identity has a receipt. */
export function isQuestionSubmissionEcho(
  value: unknown,
  receipts: readonly QuestionReceipt[],
): boolean {
  const item = object(value);
  const communication = object(item?.communication);
  if (
    communication?.kind === "system" &&
    typeof communication.message_id === "string" &&
    receipts.some(
      (receipt) =>
        receipt.source?.framework_input_id === communication.message_id &&
        receipt.session_id === communication.destination_conversation_id,
    )
  )
    return true;
  const submission = object(item?.question_submission ?? communication?.question_submission);
  if (
    !submission ||
    typeof submission.session_id !== "string" ||
    typeof submission.elicitation_id !== "string" ||
    typeof submission.submission_id !== "string"
  )
    return false;
  return receipts.some(
    (receipt) =>
      receipt.session_id === submission.session_id &&
      receipt.elicitation_id === submission.elicitation_id &&
      receipt.submission_id === submission.submission_id,
  );
}

/** Skip legacy answered:<call_id> hydration only with an exact trusted source call. */
export function receiptCoversQuestionCall(
  value: unknown,
  receipts: readonly QuestionReceipt[],
  sessionId?: string,
): boolean {
  const item = object(value);
  if (
    item?.type !== "function_call" ||
    item.name !== "AskUserQuestion" ||
    typeof item.call_id !== "string"
  )
    return false;
  return receipts.some((receipt) => {
    if (sessionId && receipt.session_id !== sessionId) return false;
    const source = receipt.source;
    return (
      source &&
      [source.call_id, source.tool_call_id, source.tool_use_id].some(
        (id) => typeof id === "string" && id === item.call_id,
      )
    );
  });
}
