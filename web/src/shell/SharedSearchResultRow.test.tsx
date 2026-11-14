// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageSearchFilterControl, SharedSearchResultRow } from "./SharedSearchResultRow";
import type { MessageSearchHit } from "./contextSearch/types";

const hit: MessageSearchHit = {
  kind: "message",
  session_id: "chat",
  item_id: "message",
  title: "Design notes",
  sender_name: "Research agent",
  role: "assistant",
  created_at: 1736935500,
  text: "**needle** in `code`",
  snippet: "**needle** in `code`",
  snippet_start: 0,
  ranges: [{ start: 2, end: 8 }],
  content_hash: "hash",
  occurrence_count: 1,
};

afterEach(cleanup);

describe("shared search result row", () => {
  it.each(["all", "current"] as const)(
    "uses one sender/date header and one excerpt in %s scope",
    (scope) => {
      const { container } = render(
        <SharedSearchResultRow hit={hit} query="needle" scope={scope} />,
      );
      expect(container).toHaveTextContent(
        scope === "all" ? "Design notes: Research agent" : "Research agent",
      );
      if (scope === "current") expect(container).not.toHaveTextContent("Design notes");
      expect(container.querySelectorAll("time")).toHaveLength(1);
      expect(container.querySelector("time")).toHaveAttribute(
        "datetime",
        "2025-01-15T10:05:00.000Z",
      );
      expect(container.querySelector("mark")).toHaveTextContent("needle");
      expect(container.querySelector("mark")).toHaveClass(
        "bg-transparent",
        "font-semibold",
        "text-primary",
      );
      expect(container.querySelector("[data-search-result]")?.children).toHaveLength(2);
      expect(container.querySelector("[data-search-result]")?.lastElementChild).toHaveClass(
        "truncate",
      );
    },
  );

  it("uses authoritative title ranges and last-message previews without marking a body match", () => {
    const title = {
      ...hit,
      kind: "chat" as const,
      title: "😀 Roadmap",
      title_ranges: [{ start: 0, end: 2 }],
      snippet: "Latest message preview",
      ranges: [],
      occurrence_count: 0,
    };
    const { container } = render(<SharedSearchResultRow hit={title} query="😀" />);
    expect(container.querySelectorAll("mark")).toHaveLength(1);
    expect(container.querySelector("mark")).toHaveTextContent("😀");
    expect(container).toHaveTextContent("Latest message preview");
  });

  it("renders text safely and leaves an absent timestamp absent", () => {
    const { container } = render(
      <SharedSearchResultRow
        hit={{
          ...hit,
          created_at: null,
          snippet:
            "[site](https://example.test) ![image](https://example.test/image.png) <script>attack()</script>",
          ranges: [],
        }}
        query="needle"
      />,
    );
    expect(container.querySelector("time,a,img,script,iframe")).toBeNull();
    expect(container).toHaveTextContent("site image <script>attack()</script>");
  });

  it("does not infer a human sender from an unclassified user role", () => {
    const { container } = render(
      <SharedSearchResultRow
        hit={{ ...hit, role: "user", sender_name: null, user_authored: undefined }}
        query="needle"
      />,
    );
    expect(container).toHaveTextContent("Design notes: External input");
  });
});

it.each([
  ["All", "all", "Entire chat history"],
  ["Final", "final", "User messages and final agent replies; no intermediate updates"],
  ["User", "user", "User messages only"],
] as const)(
  "reuses the shared segmented control and exact %s tooltip",
  async (label, value, tooltip) => {
    const onChange = vi.fn();
    const { container } = render(<MessageSearchFilterControl value="all" onChange={onChange} />);
    const button = screen.getByRole("button", { name: label });
    expect(button).toHaveAttribute("aria-pressed", String(value === "all"));
    expect(container.querySelector('[data-slot="segmented-control"]')).toBeTruthy();
    fireEvent.focus(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(tooltip);
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(value);
  },
);
