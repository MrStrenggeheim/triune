// Modified for Triune; inherited notices remain applicable.
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { FilePathAwareMessageResponse } from "@/components/blocks/ChatMarkdown";
import {
  chatQueryRanges,
  chatSearchSources,
  searchSourceElement,
  sourceOccurrenceRange,
} from "./chatSearchHighlights";

afterEach(() => {
  document.body.innerHTML = "";
});

function body(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe("exact chat occurrence mapping", () => {
  it("locates and maps actual plain-text assistant fallbacks without including row controls", () => {
    const source = "😀".repeat(35000) + " needle✓ then needle✓.";
    const sources = chatSearchSources([
      {
        kind: "assistant",
        responseId: "response",
        stableId: "response",
        lifecycle: "completed",
        error: null,
        items: [{ kind: "text", itemId: "one", text: source, final: true }],
      },
    ]);
    const { container } = render(
      <div data-message-id="response">
        <div data-testid="assistant-text-section" data-search-item-id="one">
          <FilePathAwareMessageResponse mode="static">{source}</FilePathAwareMessageResponse>
        </div>
        <button type="button">needle✓</button>
      </div>,
    );
    expect(container.querySelector(".message-markdown")).toBeNull();
    const element = searchSourceElement(container, sources[0]);
    expect(element).not.toBeNull();
    const start = source.lastIndexOf("needle✓");
    const range = sourceOccurrenceRange(element!, source, start, start + 7);
    expect(range?.toString()).toBe("needle✓");
    expect(range?.startOffset).toBe(start);
    expect(chatQueryRanges(element!, "needle✓")).toHaveLength(2);
  });

  it("distinguishes repeated Unicode literals and regex characters across Markdown nodes", () => {
    const root = body("<p>😀 <strong>c++[x]</strong> 😀 <code>c++[x]</code></p>");
    const source = "😀 **c++[x]** 😀 `c++[x]`";
    const start = source.lastIndexOf("c++[x]");
    const range = sourceOccurrenceRange(root, source, start, start + 6);
    expect(range?.toString()).toBe("c++[x]");
    expect(range?.startContainer.parentElement?.tagName).toBe("CODE");
    expect(chatQueryRanges(root, "c++[x]")).toHaveLength(2);
  });

  it("maps literal code across syntax highlighting spans and ignores its controls", () => {
    const root = body(
      "<button>echo</button><pre><code><span>echo</span> 😀 <span>echo</span></code></pre>",
    );
    const source = "```sh\necho 😀 echo\n```";
    const start = source.lastIndexOf("echo");
    const range = sourceOccurrenceRange(root, source, start, start + 4);
    expect(range?.startContainer.parentElement).toBe(root.querySelectorAll("span")[1]);
    expect(chatQueryRanges(root, "echo")).toHaveLength(2);
  });

  it("rejects ambiguous hidden Markdown source, stale text and invalid offsets", () => {
    const root = body('<p><a href="echo">echo</a></p>');
    expect(sourceOccurrenceRange(root, "[echo](echo)", 1, 5)).toBeNull();
    expect(sourceOccurrenceRange(root, "changed", 0, 4)).toBeNull();
    expect(sourceOccurrenceRange(root, "echo", -1, 4)).toBeNull();
    expect(sourceOccurrenceRange(root, "echo", 0, 9)).toBeNull();
  });

  it("does not map a collapsed prefix to a later identical source occurrence", () => {
    const root = body("<p>echo</p>");
    expect(sourceOccurrenceRange(root, "echo echo", 5, 9)).toBeNull();
  });

  it("does not highlight a query assembled across separate paragraph boundaries", () => {
    const root = body("<p>echo</p><p>echo</p>");
    expect(chatQueryRanges(root, "echoecho")).toHaveLength(0);
    expect(chatQueryRanges(root, "echo\necho")).toHaveLength(0);
    expect(chatQueryRanges(root, "echo")).toHaveLength(2);
  });

  it("maps actual Streamdown formatted prose and fenced code", async () => {
    const source = "😀 **echo** and `echo`\n\n```ts\nconst echo = 'echo';\n```";
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <FilePathAwareMessageResponse mode="static">{source}</FilePathAwareMessageResponse>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(container.querySelector("pre code")).not.toBeNull());
    const start = source.lastIndexOf("echo");
    await waitFor(() => {
      const range = sourceOccurrenceRange(
        container.querySelector(".message-markdown")!,
        source,
        start,
        start + 4,
      );
      expect(range?.toString()).toBe("echo");
      expect(range?.startContainer.parentElement?.closest("pre")).not.toBeNull();
    });
  });
});

it("resolves an assistant item ID to its exact response section", () => {
  const sources = chatSearchSources([
    {
      kind: "assistant",
      responseId: "response",
      stableId: "response",
      lifecycle: "completed",
      error: null,
      items: [
        { kind: "text", itemId: "one", text: "echo", final: true },
        { kind: "text", itemId: "two", text: "echo", final: true },
      ],
    },
  ]);
  const root = body(
    '<div data-message-id="response"><div data-testid="assistant-text-section" data-search-item-id="one"><p class="message-markdown">echo</p></div><div data-testid="assistant-text-section" data-search-item-id="two"><p class="message-markdown">echo</p></div></div>',
  );
  expect(searchSourceElement(root, sources[1])).toBe(root.querySelectorAll("p")[1]);
  root.querySelector('[data-testid="assistant-text-section"]')!.remove();
  expect(searchSourceElement(root, sources[1])).toBe(root.querySelector("p"));
});

it("keeps the backend's raw space-joined source independently of rendered concatenation", () => {
  const items = [
    {
      kind: "text" as const,
      itemId: "raw",
      text: "firstsecond",
      searchText: "first second",
      final: true,
    },
  ];
  expect(
    chatSearchSources([
      {
        kind: "assistant",
        responseId: "row",
        stableId: "row",
        lifecycle: "completed",
        error: null,
        items,
      },
    ])[0].text,
  ).toBe("first second");
  expect(
    chatSearchSources([
      {
        kind: "user",
        itemId: "user",
        content: [
          { type: "input_text", text: "first" },
          { type: "input_text", text: "" },
          { type: "input_text", text: "second" },
        ],
      },
    ])[0].text,
  ).toBe("first second");
});
