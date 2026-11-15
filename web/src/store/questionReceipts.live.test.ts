// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, describe, expect, it } from "vitest";
import { BlockStream } from "@/lib/blockStream";
import type { ElicitationBlock } from "@/lib/blocks";
import {
  isQuestionSubmissionEcho,
  questionBatchFromItem,
  questionReceiptBlock,
} from "@/lib/questionBatches";
import { parseEvent } from "@/lib/sse";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import { buildBubbles } from "@/lib/renderItems";
import {
  bindConversationForTest,
  handleSessionEvent,
  pumpStreamEvents,
  releaseConversation,
} from "./chatStore";

const sessionId = "live-question-receipts";
const receiptItem = (elicitationId = "batch-1") => ({
  id: `receipt-${elicitationId}`,
  response_id: `submission-${elicitationId}`,
  created_at: 123,
  type: "resource_event",
  resource_type: "question_batch",
  event_type: "session.question.answered",
  resource: {
    version: 1,
    session_id: sessionId,
    elicitation_id: elicitationId,
    submission_id: `submission-${elicitationId}`,
    action: "accept",
    source: { framework_input_id: `framework-${elicitationId}` },
    questions: [
      { id: "question_0", header: "Color", question: "Pick?", answered: true, answer: "Blue" },
      { id: "question_1", question: "Secret?", answered: true, redacted: true },
    ],
  },
});
const frame = (event: string, data: Record<string, unknown>) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const receiptFrame = (id = "batch-1") =>
  frame("response.output_item.done", { item: receiptItem(id) });
const pendingFrame = frame("response.elicitation_request", {
  elicitation_id: "batch-1",
  params: {
    message: "Pick?",
    phase: "codex_request_user_input",
    ask_user_question: { questions: [{ id: "question_0", question: "Pick?", options: [] }] },
  },
});

afterEach(() => releaseConversation(sessionId));

describe("canonical question receipt transport", () => {
  it.each(["before", "after"])(
    "hides only the correlated empty/decline System control arriving %s the receipt",
    async (order) => {
      const origin = {
        kind: "system",
        message_id: "framework-batch-1",
        destination_conversation_id: sessionId,
        delivery_state: "confirmed",
      };
      const control = {
        id: "framework-batch-1",
        type: "message",
        response_id: "control-turn",
        content: [{ type: "input_text", text: "question_submission" }],
        communication: origin,
      };
      expect(isQuestionSubmissionEcho(control, [questionBatchFromItem(receiptItem())!])).toBe(true);
      const otherControl = {
        ...control,
        id: "other-control",
        communication: { ...origin, destination_conversation_id: "another-session" },
      };
      expect(isQuestionSubmissionEcho(otherControl, [questionBatchFromItem(receiptItem())!])).toBe(
        false,
      );
      const controlFrame = frame("response.output_item.done", { item: control });
      const otherFrame = frame("response.output_item.done", { item: otherControl });
      const { set, get } = bindConversationForTest(sessionId, { blocks: [] });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              (order === "before" ? controlFrame + receiptFrame() : receiptFrame() + controlFrame) +
                otherFrame,
            ),
          );
          controller.close();
        },
      });
      await pumpStreamEvents(sessionId, body, new AbortController(), set, get, {
        schedule() {},
        cancel() {},
      });
      expect(get().blocks.map((block) => block.type)).toEqual(["elicitation", "user_message"]);
      expect(get().blocks[1]!.ctx.itemId).toBe("other-control");
    },
  );

  it.each(["before", "after", "history-first", "buffered"])(
    "reconciles System input consumption %s the canonical receipt without hiding human input",
    async (order) => {
      const content = [{ type: "input_text" as const, text: "question_submission" }];
      const communication = {
        kind: "system" as const,
        message_id: "framework-batch-1",
        destination_conversation_id: sessionId,
        delivery_state: "confirmed" as const,
      };
      const human = {
        id: "genuine-human",
        type: "message" as const,
        response_id: "human-turn",
        status: "completed" as const,
        role: "user" as const,
        user_authored: true,
        content,
      };
      const next = { tempId: "next-send", content };
      const { set, get } = bindConversationForTest(sessionId, {
        blocks: itemsToBlocks([
          human,
          ...(order === "history-first" ? [{ ...human, id: communication.message_id }] : []),
        ]),
        pendingUserMessages: [{ tempId: "pending-control", content, communication }, next],
      });
      const consume = () =>
        handleSessionEvent(
          {
            type: "session_input_consumed",
            itemId: communication.message_id,
            itemType: "message",
            clearedPendingId: "pending-control",
            data: { role: "user", content, communication },
          },
          sessionId,
        );
      if (order === "before") consume();
      let consumedWhileBuffered = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const first =
            order === "buffered"
              ? frame("response.output_item.done", {
                  item: {
                    ...human,
                    id: "other-control",
                    communication: { ...communication, message_id: "other-control" },
                  },
                })
              : "";
          controller.enqueue(new TextEncoder().encode(first + receiptFrame()));
          controller.close();
        },
      });
      await pumpStreamEvents(sessionId, body, new AbortController(), set, get, {
        schedule() {
          if (order !== "buffered") return;
          expect(get().blocks.some((block) => block.type === "elicitation")).toBe(false);
          consume();
          expect(get().blocks.some((block) => block.ctx.itemId === communication.message_id)).toBe(
            true,
          );
          consumedWhileBuffered = true;
        },
        cancel() {},
      });
      if (order === "buffered") expect(consumedWhileBuffered).toBe(true);
      if (order !== "before") consume();
      consume();
      handleSessionEvent(
        {
          type: "session_input_consumed",
          itemId: "other-control",
          itemType: "message",
          data: {
            role: "user",
            content,
            communication: { ...communication, message_id: "other-control" },
          },
        },
        sessionId,
      );
      expect(get().blocks.map((block) => block.ctx.itemId)).toEqual([
        "genuine-human",
        ...(order === "buffered"
          ? ["other-control", "receipt-batch-1"]
          : ["receipt-batch-1", "other-control"]),
      ]);
      expect(get().blocks[0]).toMatchObject({ userAuthored: true, content });
      expect(get().blocks.find((block) => block.ctx.itemId === "other-control")).toMatchObject({
        communication: { kind: "system", message_id: "other-control" },
      });
      expect(get().pendingUserMessages).toEqual([next]);
    },
  );

  it("validates canonical resources and reduces them without adopting their backdated turn", () => {
    const parsed = parseEvent("response.output_item.done", { item: receiptItem() });
    expect(parsed?.type).toBe("question_receipt");
    expect(
      parseEvent("response.output_item.done", {
        item: { ...receiptItem(), resource: { ...receiptItem().resource, questions: [] } },
      }),
    ).toBeNull();
    const blocks = new BlockStream().reduceSync([
      {
        type: "response_created",
        response: { id: "current-turn", status: "in_progress", model: "codex" },
      },
      parsed!,
      { type: "text_delta", delta: "Next text\n" },
    ]);
    const receipt = blocks.find(
      (block): block is ElicitationBlock => block.type === "elicitation",
    )!;
    expect(receipt.ctx).toMatchObject({ itemId: "receipt-batch-1", createdAtS: 123 });
    expect(receipt.response?.content).toEqual({ question_0: "Blue" });
    expect(receipt.askUserQuestion).toMatchObject({
      questions: [
        expect.objectContaining({ question: "Pick?" }),
        expect.objectContaining({ question: "Secret?" }),
      ],
    });
    expect(blocks.find((block) => block.type === "text_chunk")?.ctx.responseId).toBe(
      "current-turn",
    );
  });

  it("attaches a declined reloaded batch's interrupted marker to its exact native turn", async () => {
    const responseId = "codex_native-question-turn";
    const pending = new BlockStream().reduceSync([
      parseEvent("response.elicitation_request", JSON.parse(pendingFrame.split("data: ")[1]!))!,
    ]);
    const { set, get } = bindConversationForTest(sessionId, {
      blocks: pending,
      isNativeTerminalSession: true,
      status: "streaming",
      sessionStatus: "running",
      activeResponse: { responseId, state: "streaming", error: null },
    });
    const item = receiptItem();
    const receipt = {
      ...item,
      resource: {
        ...item.resource,
        action: "decline",
        source: {
          thread_id: "native-question-thread",
          turn_id: "native-question-turn",
          item_id: "shelf_question",
          codex_request_id: 0,
        },
      },
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame("response.output_item.done", { item: receipt }) +
              frame("session.interrupted", { data: { response_id: responseId } }) +
              frame("session.status", {
                conversation_id: sessionId,
                status: "idle",
                response_id: responseId,
              }),
          ),
        );
        controller.close();
      },
    });
    await pumpStreamEvents(sessionId, body, new AbortController(), set, get, {
      schedule() {},
      cancel() {},
    });
    const state = get();
    expect(state.status).toBe("idle");
    expect(state.sessionStatus).toBe("idle");
    expect(
      buildBubbles(state.blocks, state.activeResponse, undefined, state.interruptedResponseIds),
    ).toMatchObject([{ kind: "assistant", responseId, lifecycle: "cancelled" }]);
  });

  it.each(["pending", "optimistic", "buffered", "hydrated"])(
    "keeps one authoritative card at its original position from %s state",
    async (mode) => {
      const parsed = parseEvent(
        "response.elicitation_request",
        JSON.parse(pendingFrame.split("data: ")[1]!),
      )!;
      const pending = new BlockStream().reduceSync([parsed])[0] as ElicitationBlock;
      if (mode === "optimistic") {
        pending.status = "responded";
        pending.response = { action: "accept", content: { question_0: "optimistic" } };
      }
      const anchor = {
        type: "text_done" as const,
        ctx: { ...pending.ctx, itemId: "anchor" },
        fullText: "Keep position",
        hasCodeBlocks: false,
      };
      const initial =
        mode === "buffered"
          ? []
          : [mode === "hydrated" ? questionReceiptBlock(receiptItem())! : pending, anchor];
      const { set, get } = bindConversationForTest(sessionId, { blocks: initial });
      const payload =
        (mode === "buffered" ? pendingFrame : "") +
        receiptFrame() +
        receiptFrame() +
        receiptFrame("batch-2");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      });
      await pumpStreamEvents(sessionId, body, new AbortController(), set, get, {
        schedule() {},
        cancel() {},
      });
      const cards = get().blocks.filter(
        (block): block is ElicitationBlock => block.type === "elicitation",
      );
      expect(cards).toHaveLength(2);
      expect(cards.map((block) => block.elicitationId)).toEqual(["batch-1", "batch-2"]);
      expect(cards[0]!.phase).toBe("question_receipt");
      expect(cards[0]!.response?.content).toEqual({ question_0: "Blue" });
      if (mode !== "buffered") {
        expect(cards[0]!.ctx).toBe(initial[0]!.ctx);
        expect(get().blocks[1]).toBe(anchor);
      }
    },
  );
});
