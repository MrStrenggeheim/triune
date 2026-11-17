// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTranscriptConvergenceDisplay } from "./useTranscriptConvergenceDisplay";
import { itemsToBlocks } from "@/lib/itemsToBlocks";

const state = vi.hoisted(() => ({ scope: "viewer-a", record: vi.fn(), attemptId: "attempt-one" }));
vi.mock("@/lib/convergenceDiagnostics", () => ({
  recordTranscriptDisplayed: state.record,
  readBlockConvergenceIdentity: () => ({ attemptId: state.attemptId }),
}));
vi.mock("@/lib/resourceViewStorage", () => ({ resourceViewStorageScope: () => state.scope }));

const blocks = itemsToBlocks([
  {
    id: "on-screen",
    response_id: "display-turn",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Fixture" }],
  },
]);
function Surface({ visible = true, version = 1 }: { visible?: boolean; version?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useTranscriptConvergenceDisplay(ref, "conversation-a", visible, version, undefined, blocks);
  return (
    <div ref={ref}>
      <div data-search-item-id="on-screen">Private body must never be recorded</div>
      <div data-user-message-id="off-screen" />
      <div hidden>
        <div data-search-item-id="folded" />
      </div>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  state.scope = "viewer-a";
  state.attemptId = "attempt-one";
  state.record.mockClear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = this.dataset.userMessageId === "off-screen" ? 2000 : 20;
    return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100 } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("records committed visible identities without content, offscreen or folded rows", () => {
  render(<Surface />);
  state.attemptId = "successor-attempt";
  act(() => vi.advanceTimersByTime(300));
  expect(state.record.mock.calls).toEqual([
    ["conversation-a", { itemId: "on-screen", attemptId: "attempt-one" }, "viewer-a"],
  ]);
});

it("cancels samples when the view hides, unmounts or the authenticated scope changes", () => {
  const view = render(<Surface />);
  view.rerender(<Surface visible={false} />);
  act(() => vi.advanceTimersByTime(300));
  expect(state.record).not.toHaveBeenCalled();
  view.rerender(<Surface />);
  state.scope = "viewer-b";
  act(() => vi.advanceTimersByTime(300));
  expect(state.record).not.toHaveBeenCalled();
  view.rerender(<Surface version={2} />);
  view.unmount();
  act(() => vi.advanceTimersByTime(300));
  expect(state.record).not.toHaveBeenCalled();
});
