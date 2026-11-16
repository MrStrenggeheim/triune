// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { ActivityRow } from "@/components/ActivityRow";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each([0, 700])(
  "keeps the disclosure within one pixel and yields to manual input from scrollTop %s",
  (initialTop) => {
    vi.useFakeTimers();
    const context = createRef<StickToBottomContext>();
    const view = render(
      <Conversation contextRef={context}>
        <ConversationContent>
          <ActivityRow icon="A" title="Task" presentation="message">
            <p>Full task details</p>
          </ActivityRow>
        </ConversationContent>
      </Conversation>,
    );
    const scroller = context.current!.scrollRef.current!;
    scroller.style.overflowY = "auto";
    scroller.style.overflowAnchor = "auto";
    scroller.scrollTop = initialTop;
    context.current!.state.isAtBottom = true;
    const trigger = screen.getByRole("button", { name: "Expand activity" });
    let shift = 0;
    trigger.getBoundingClientRect = () =>
      ({ top: 400 + shift - scroller.scrollTop + initialTop, height: 24 }) as DOMRect;
    fireEvent.click(trigger);
    expect(context.current!.state.isAtBottom).toBe(false);
    expect(context.current!.state.escapedFromLock).toBe(true);
    expect(scroller.style.overflowAnchor).toBe("none");
    shift = 80;
    act(() => vi.advanceTimersByTime(32));
    expect(Math.abs(trigger.getBoundingClientRect().top - 400)).toBeLessThanOrEqual(1);
    fireEvent.wheel(scroller);
    expect(scroller.style.overflowAnchor).toBe("auto");
    const manualTop = scroller.scrollTop;
    shift = 160;
    act(() => vi.advanceTimersByTime(500));
    expect(scroller.scrollTop).toBe(manualTop);
    view.unmount();
  },
);
