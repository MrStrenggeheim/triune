import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposerContextRing } from "./ComposerContextRing";

function renderRing(contextWindow: number | null, tokensUsed: number | null) {
  return render(
    <TooltipProvider>
      <ComposerContextRing contextWindow={contextWindow} tokensUsed={tokensUsed} />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("ComposerContextRing", () => {
  it("renders nothing when the context window is unknown or zero", () => {
    expect(renderRing(null, 100).container).toBeEmptyDOMElement();
    expect(renderRing(0, 100).container).toBeEmptyDOMElement();
  });

  it("renders nothing when tokensUsed is unknown", () => {
    expect(renderRing(1000, null).container).toBeEmptyDOMElement();
  });

  it("keeps usage text out of the bar while preserving an accessible percentage", () => {
    renderRing(1000, 123);
    expect(screen.getByTestId("composer-context-ring")).not.toHaveTextContent("12%");
    expect(screen.getByTestId("composer-context-ring")).toHaveClass("shrink-0");
    expect(screen.getByTestId("composer-context-ring")).not.toHaveClass("gap-1");
    expect(screen.getByLabelText("12% of context used")).toBeInTheDocument();
  });

  it("shows the actual context usage in the tooltip", async () => {
    const user = userEvent.setup();
    renderRing(1000, 123);
    await user.tab();
    expect(screen.getByTestId("composer-context-ring")).toHaveFocus();
    expect(await screen.findByText("12% context used")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("123 / 1K tokens");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Context window" });
    expect(within(dialog).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "12.3");
    expect(dialog).toHaveTextContent("123 / 1,000 tokens");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button")).toHaveFocus();
  });

  it("previews on hover and preserves the draft across click and touch", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <form>
          <textarea aria-label="Draft" defaultValue="unfinished draft" />
          <ComposerContextRing contextWindow={200_000} tokensUsed={83_400} />
        </form>
      </TooltipProvider>,
    );
    const draft = screen.getByRole("textbox");
    const ring = screen.getByRole("button", { name: "42% of context used" });
    await user.click(draft);
    await user.hover(ring);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("42% context used");
    expect(draft).toHaveFocus();
    await user.click(ring);
    expect(screen.getByRole("dialog")).toHaveTextContent("83,400 / 200,000 tokens");
    await user.click(draft);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(draft).toHaveFocus();
    await user.pointer({ keys: "[TouchA]", target: ring });
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.pointer({ keys: "[TouchA]", target: ring });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(draft).toHaveValue("unfinished draft");
  });

  it("fits the SVG to the painted ring so its padding does not widen the label gap", () => {
    renderRing(1000, 490);
    const svg = screen.getByTestId("composer-context-ring").querySelector("svg");
    expect(svg).toHaveAttribute("viewBox", "1.5 1.5 13 13");
    expect(svg).toHaveAttribute("width", "13");
    expect(svg).toHaveAttribute("height", "13");
  });

  it("clamps over-full usage to 100%", () => {
    renderRing(1000, 4000);
    expect(screen.getByLabelText("100% of context used")).toBeInTheDocument();
    expect(screen.getByTestId("composer-context-ring")).not.toHaveTextContent("100%");
  });

  it("stays grayscale — never warning/destructive — even at high usage", () => {
    // WHY: the bar is ambient status, not an alarm (#7024). A near-full
    // context must not paint the old warning/destructive colors.
    renderRing(1000, 950);
    const ring = screen.getByTestId("composer-context-ring");
    expect(ring).toHaveClass("text-muted-foreground");
    expect(ring.className).not.toMatch(/text-(warning|destructive)/);
  });
});
