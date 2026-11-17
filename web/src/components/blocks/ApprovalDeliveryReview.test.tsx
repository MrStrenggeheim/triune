// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import type * as identity from "@/lib/identity";
import { BlockStream } from "@/lib/blockStream";
import { buildBubbles, type RenderItem } from "@/lib/renderItems";
import { parseEventLines } from "@/lib/sse";
import { parseRunnerApprovalDelivery } from "@/lib/runnerApprovalDelivery";
import { ApprovalCard, ElicitationCard } from "./ApprovalCard";

vi.mock("@/lib/identity", async (original) => ({
  ...(await original<typeof identity>()),
  authenticatedFetch: vi.fn(),
}));

const delivery = {
  state: "unconfirmed" as const,
  session_id: "original-session",
  elicitation_id: "question",
  attempt_id: "a".repeat(64),
  runner_id: "original-runner",
  owner_kind: "harness" as const,
};
const props = {
  elicitationId: "question",
  message: "SYNTHETIC-secret-preview",
  phase: "tool_call",
  policyName: "approval",
  contentPreview: "SYNTHETIC-secret-preview",
  requestedSchema: {},
  status: "pending" as const,
  response: null,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("original approval delivery review", () => {
  it.each([
    [1280, "message"],
    [390, "popup"],
  ] as const)("reuses the streamed shared card at width %i", (width, questionPresentation) => {
    vi.stubGlobal("innerWidth", width);
    const events = parseEventLines([
      JSON.stringify({
        event: "response.elicitation_request",
        data: {
          type: "response.elicitation_request",
          elicitation_id: "question",
          params: { message: props.message, runner_delivery: delivery },
        },
      }),
    ]);
    const blocks = new BlockStream().reduceSync([...events]);
    const bubbles = buildBubbles(blocks, null);
    const item = bubbles
      .flatMap((bubble) => (bubble.kind === "assistant" ? bubble.items : []))
      .find((candidate) => candidate.kind === "elicitation") as Extract<
      RenderItem,
      { kind: "elicitation" }
    >;
    const submit = vi.fn();
    render(
      <ElicitationCard item={item} questionPresentation={questionPresentation} onSubmit={submit} />,
    );
    expect(screen.getByTestId("approval-card")).toHaveAttribute("data-state", "delivery-unknown");
    expect(screen.getByRole("button", { name: "Recheck delivery" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /approve|reject|submit|retry sending/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review delivery" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText(delivery.attempt_id)).toBeVisible();
    expect(document.body.textContent).not.toContain(props.message);
    expect(submit).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each([200, 401, 403, 404, 409, 503])(
    "keeps the recheck button and hold when receipt is absent or denied (%i)",
    async (status) => {
      vi.mocked(authenticatedFetch).mockResolvedValue(
        new Response(JSON.stringify({ status: "pending", runner_delivery: delivery }), { status }),
      );
      render(<ApprovalCard {...props} runnerDelivery={delivery} />);
      fireEvent.click(screen.getByRole("button", { name: "Recheck delivery" }));
      expect(await screen.findByRole("status")).toHaveTextContent(/held|stays held/);
      expect(screen.getByRole("button", { name: "Recheck delivery" })).toBeEnabled();
      expect(authenticatedFetch).toHaveBeenCalledExactlyOnceWith(
        `/v1/sessions/original-session/elicitations/question?delivery_attempt_id=${delivery.attempt_id}`,
        expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
      );
    },
  );

  it("settles only the exact confirmed attempt and never posts a verdict", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "resolved",
          delivery_state: "confirmed",
          delivery_attempt_id: delivery.attempt_id,
        }),
      ),
    );
    const submit = vi.fn();
    render(<ApprovalCard {...props} runnerDelivery={delivery} onSubmit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "Recheck delivery" }));
    expect(await screen.findByText("Delivery confirmed")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Recheck delivery" })).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([undefined, "another-attempt"])(
    "keeps generic resolution or a foreign receipt held (%s)",
    async (attempt) => {
      vi.mocked(authenticatedFetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "resolved",
            delivery_state: "confirmed",
            delivery_attempt_id: attempt,
          }),
        ),
      );
      render(<ApprovalCard {...props} runnerDelivery={delivery} />);
      fireEvent.click(screen.getByRole("button", { name: "Recheck delivery" }));
      expect(await screen.findByRole("status")).toHaveTextContent("Delivery remains unknown");
      expect(screen.getByRole("button", { name: "Recheck delivery" })).toBeEnabled();
    },
  );

  it("cancels a stale recheck when the card identity changes", async () => {
    let complete!: (value: Response) => void;
    vi.mocked(authenticatedFetch).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const view = render(<ApprovalCard {...props} runnerDelivery={delivery} />);
    fireEvent.click(screen.getByRole("button", { name: "Recheck delivery" }));
    expect(screen.getByRole("button", { name: "Recheck delivery" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Recheck delivery" }));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(authenticatedFetch).mock.calls[0]![1]!.signal!;
    view.rerender(
      <ApprovalCard {...props} runnerDelivery={{ ...delivery, attempt_id: "b".repeat(64) }} />,
    );
    expect(signal.aborted).toBe(true);
    await act(async () =>
      complete(
        new Response(
          JSON.stringify({
            status: "resolved",
            delivery_state: "confirmed",
            delivery_attempt_id: delivery.attempt_id,
          }),
        ),
      ),
    );
    expect(screen.getByText("Delivery unknown")).toBeVisible();
    expect(screen.getByRole("button", { name: "Recheck delivery" })).toBeEnabled();
  });

  it("copies only safe metadata and rejects malformed descriptors", () => {
    expect(
      parseRunnerApprovalDelivery({
        ...delivery,
        answer: "SYNTHETIC-secret",
        answer_hash: "weak-hash",
      }),
    ).toEqual(delivery);
    expect(parseRunnerApprovalDelivery({ ...delivery, attempt_id: null })).toBeUndefined();
    expect(parseRunnerApprovalDelivery({ ...delivery, owner_kind: "foreign" })).toBeUndefined();
  });
});
