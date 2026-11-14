// Modified for Triune; inherited notices remain applicable.
// Tests for TodoPanel — the small presentational panel that mirrors Claude
// Code's todo list from useChatStore.todos. We mock the store so the panel's
// own rendering (empty state, per-status icon/strikethrough, activeForm
// subtitle) is exercised in isolation.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

// The store is a selector hook: useChatStore((s) => s.todos). Mock it to feed a
// controllable todos array per test.
const h = vi.hoisted(() => ({ todos: [] as TodoItem[] }));
vi.mock("@/store/chatStore", () => ({
  useChatStore: (selector: (s: { todos: TodoItem[] }) => unknown) => selector({ todos: h.todos }),
}));

import { TodoPanel } from "./TodoPanel";

afterEach(() => {
  cleanup();
  h.todos = [];
});

describe("TodoPanel", () => {
  it("renders nothing when the todo list is empty", () => {
    // WHY: the panel must occupy no space for sessions with no todos — it
    // returns null, so the container has no DOM children.
    h.todos = [];
    const { container } = render(<TodoPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one list item per todo with its content", () => {
    // WHY: confirms the map over todos renders every item's content text.
    h.todos = [
      { content: "Write tests", status: "pending", activeForm: "Writing tests" },
      { content: "Ship it", status: "completed", activeForm: "Shipping it" },
      { content: "Build it", status: "in_progress", activeForm: "Building it" },
    ];
    render(<TodoPanel />);
    expect(screen.getByText("Write tests")).toBeInTheDocument();
    expect(screen.getByText("Ship it")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    for (const [index, state] of ["unchecked", "checked", "indeterminate"].entries()) {
      const visual = rows[index]!.querySelector('[data-slot="checkbox-visual"]')!;
      expect(visual).toHaveAttribute("data-state", state);
      expect(visual).toHaveAttribute("aria-hidden", "true");
      expect(visual).not.toHaveAttribute("tabindex");
      fireEvent.click(visual);
      fireEvent.keyDown(visual, { key: " " });
      expect(visual).toHaveAttribute("data-state", state);
    }
    expect(screen.getByText("Pending")).toHaveClass("sr-only");
    expect(screen.getByText("In progress")).toHaveClass("sr-only");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(rows[0]!.parentElement!.querySelector("input, button, [tabindex]")).toBeNull();
  });

  it("strikes through completed text while keeping the status visual opaque", () => {
    h.todos = [{ content: "Done thing", status: "completed", activeForm: "Doing thing" }];
    render(<TodoPanel />);
    const span = screen.getByText("Done thing");
    expect(span.className).toContain("line-through");
    expect(span.closest("li")).not.toHaveClass("opacity-50");
    expect(span).toHaveClass("text-muted-foreground");
    expect(screen.getByText("Completed")).toHaveClass("sr-only");
  });

  it("shows the activeForm subtitle for an in_progress todo when it differs", () => {
    // WHY: an in-progress item surfaces its activeForm ("Doing X") under the
    // content — this is the live-status affordance.
    h.todos = [{ content: "Build feature", status: "in_progress", activeForm: "Building feature" }];
    render(<TodoPanel />);
    expect(screen.getByText("Build feature")).toBeInTheDocument();
    expect(screen.getByText("Building feature")).toBeInTheDocument();
  });

  it("omits the activeForm subtitle when it equals the content", () => {
    // WHY: the guard `activeForm !== content` prevents a redundant duplicate
    // line; identical text must appear exactly once.
    h.todos = [{ content: "Same text", status: "in_progress", activeForm: "Same text" }];
    render(<TodoPanel />);
    expect(screen.getAllByText("Same text")).toHaveLength(1);
  });

  it("does not show the activeForm subtitle for a non-in_progress todo", () => {
    // WHY: the subtitle is gated on in_progress; a pending todo with a distinct
    // activeForm must not render it.
    h.todos = [{ content: "Pending thing", status: "pending", activeForm: "Pending action" }];
    render(<TodoPanel />);
    expect(screen.queryByText("Pending action")).toBeNull();
  });
});
