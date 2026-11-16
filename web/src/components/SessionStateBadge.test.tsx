// Modified for Triune.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionStateBadge, getSessionStatusGroups } from "./SessionStateBadge";
import type { SessionState } from "@/hooks/useSessionState";

function renderBadge(state: SessionState) {
  return render(
    <TooltipProvider>
      <SessionStateBadge state={state} />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("SessionStateBadge — per-state rendering", () => {
  it("renders awaiting as a 'Needs response' tag with a count-aware accessible label", () => {
    renderBadge({ kind: "awaiting", count: 3 });
    const badge = screen.getByTestId("session-state-badge");
    expect(badge).toHaveAttribute("data-state", "awaiting");
    expect(badge).toHaveAttribute("aria-label", "3 approval prompts waiting");
    // The approval indicator is a visible text tag (not an icon-only dot), so
    // it reads as "Needs response" at a glance in the row.
    expect(badge).toHaveTextContent("Needs response");
  });

  it("uses singular wording when only one prompt is pending", () => {
    renderBadge({ kind: "awaiting", count: 1 });
    expect(screen.getByTestId("session-state-badge")).toHaveAttribute(
      "aria-label",
      "1 approval prompt waiting",
    );
  });

  it("renders running with a spinning grey spinner", () => {
    const { container } = renderBadge({ kind: "running" });
    const badge = screen.getByTestId("session-state-badge");
    expect(badge).toHaveAttribute("data-state", "running");
    // The running indicator is a grey spinner; a missing spinner
    // (or the old success-tone dot grid) means it regressed.
    const spinner = container.querySelector('[data-testid="running-dot"]');
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute("class")).toContain("animate-spin");
    expect(spinner?.getAttribute("class")).toContain("text-muted-foreground");
    expect(spinner?.getAttribute("class")).toContain("size-3");
    expect(container.querySelector(".bg-success")).toBeNull();
  });

  it("renders starting with the same spinner as running and its own label", () => {
    const { container } = renderBadge({ kind: "starting" });
    const badge = screen.getByTestId("session-state-badge");
    expect(badge).toHaveAttribute("data-state", "starting");
    expect(badge).toHaveAttribute("aria-label", "Session starting up");
    const spinner = container.querySelector('[data-testid="running-dot"]');
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute("class")).toContain("animate-spin");
  });

  it("renders unseen messages as a solid (non-pulsing) brand-pink dot", () => {
    const { container } = renderBadge({ kind: "unseen" });
    const badge = screen.getByTestId("session-state-badge");
    expect(badge).toHaveAttribute("aria-label", "New messages");
    expect(badge).toHaveAttribute("data-state", "unseen");
    // Unread reuses the brand-pink token but stays static; the pulsing
    // variant (running-pulse-dot) is reserved for the running state.
    const dot = container.querySelector(".bg-brand-accent");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("class")).toContain("size-1.5");
    expect(dot?.getAttribute("class")).not.toContain("running-pulse-dot");
    expect(container.querySelector(".bg-info")).toBeNull();
  });

  it("renders a static CircleAlert in the same destructive color as error text", () => {
    const { container } = renderBadge({ kind: "error" });
    const badge = screen.getByRole("img", { name: "Latest message is an error" });
    expect(badge).toHaveAttribute("data-state", "error");
    const icon = container.querySelector("svg.lucide-circle-alert");
    expect(icon).toHaveClass("size-3.5", "shrink-0", "text-destructive");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).not.toHaveClass("animate-spin", "animate-pulse", "text-brand-accent");
  });

  it("renders a host disconnect as a neutral outline dot", () => {
    const { container } = renderBadge({ kind: "disconnected" });
    const badge = screen.getByRole("img", { name: "Host disconnected" });
    expect(badge).toHaveAttribute("data-state", "disconnected");
    expect(container.querySelector("svg")).toBeNull();
    expect(badge.firstElementChild).toHaveClass(
      "size-2",
      "rounded-full",
      "border",
      "border-muted-foreground",
    );
  });
});

it("offers the same count-aware compact visual without a nested tooltip", () => {
  render(<SessionStateBadge state={{ kind: "awaiting", count: 4 }} compact tooltip={false} />);
  const badge = screen.getByRole("img", { name: "4 approval prompts waiting" });
  expect(badge.querySelector("svg")).not.toBeNull();
  expect(badge).not.toHaveTextContent("Needs response");
  expect(badge).not.toHaveAttribute("data-slot", "tooltip-trigger");
});

it.each([
  {
    states: [
      { kind: "error" },
      { kind: "awaiting", count: 2 },
      { kind: "running" },
      { kind: "unseen" },
    ],
    draft: true,
    attention: "error",
    activity: "running",
  },
  {
    states: [{ kind: "awaiting", count: 2 }, { kind: "running" }],
    draft: true,
    attention: "awaiting",
    activity: "running",
  },
  { states: [{ kind: "unseen" }], draft: true, attention: "draft", activity: "unseen" },
  { states: [], draft: false, attention: undefined, activity: undefined },
] satisfies {
  states: SessionState[];
  draft: boolean;
  attention: string | undefined;
  activity: string | undefined;
}[])(
  "selects independent attention=$attention and activity=$activity groups",
  ({ states, draft, attention, activity }) => {
    const groups = getSessionStatusGroups(states, draft);
    expect(groups.attention?.kind).toBe(attention);
    expect(groups.activity?.kind).toBe(activity);
  },
);
