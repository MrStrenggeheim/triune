// Modified for Triune; inherited notices remain applicable.
// End-to-end rendering of a markdown link whose href is a workspace file.
//
// Agents link files they just wrote (`[foo.md](/abs/ws/foo.md)`). Two ways this
// used to go wrong, both reproduced here so a regression is loud:
//
//   - An absolute path stayed a real anchor, so clicking it navigated the app
//     origin and the server answered {"detail":"Not Found"}.
//   - A path with no leading slash had its href stripped and " [blocked]"
//     appended, which read as though the app had censored the link.
//
// Both should instead open the FileViewer, exactly as an inline-code path does.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileViewerContext } from "@/shell/FileViewerContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { FilePathAwareMessageResponse } from "./ChatMarkdown";
import { AttachmentPreviewContext } from "@/components/ChatAttachment";
import type { ComponentProps } from "react";
import type { ChatFileLocation } from "@/lib/chatFileReferences";

vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));
import { showToast } from "@/components/ui/toast";

const { copyTextMock } = vi.hoisted(() => ({
  copyTextMock: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: copyTextMock }));
vi.mock("@/lib/notifications", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "@/lib/notifications";

const toastMock = vi.mocked(showToast);
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
  copyTextMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

// Absolute (base=host) listings echo entries as names relative to the listed
// dir, with the dir itself in `base` — mirror that wire shape so what's
// tested includes the existence check re-attaching the dir.
function dirListing(paths: string[]): Response {
  const parent = paths.length ? paths[0].slice(0, paths[0].lastIndexOf("/")) || "/" : "/";
  return jsonResponse({
    object: "list",
    base: parent,
    data: paths.map((path) => ({
      id: path,
      name: path.split("/").pop(),
      path: path.split("/").pop(),
      type: "file",
      bytes: 5,
      modified_at: 1,
    })),
    has_more: false,
  });
}

const WORKSPACE = "/home/u/ws";
const SOURCE_WORKSPACE: NonNullable<ChatFileLocation["workspace"]> = {
  id: "original-workspace",
  host_id: "original-host",
  target_kind: "host",
  root: "/original/workspace",
  capabilities: ["files"],
};

function referenceMetadata(path: string, kind: ChatFileLocation["kind"] = "file"): Response {
  const value: ChatFileLocation =
    kind === "captured"
      ? { kind, path, workspace: SOURCE_WORKSPACE }
      : { kind, path, workspace: SOURCE_WORKSPACE };
  return jsonResponse(value);
}

/** Keep classification and authenticated preview bytes on distinct routes. */
function mockCapturedReference({
  path,
  content,
  contentType = "text/plain",
  kind = "file",
}: {
  path: string;
  content: string;
  contentType?: string;
  kind?: ChatFileLocation["kind"];
}) {
  const base = "/v1/sessions/conv_1/attachments/references/original-item";
  const query = new URLSearchParams({ path });
  const metadataUrl = `${base}/metadata?${query}`;
  const contentUrl = `${base}?${query}`;
  fetchMock.mockImplementation(async (url: string) => {
    if (url === metadataUrl) return referenceMetadata(path, kind);
    if (url === contentUrl)
      return new Response(content, { headers: { "Content-Type": contentType } });
    throw new Error(`Unexpected reference request: ${url}`);
  });
  return { metadataUrl, contentUrl };
}

// Module scope so the provider value is a constant (jsx-no-constructed-context-values);
// `renderMarkdown` swaps the changed-file list and resets the spy per test.
const openFile = vi.fn();
let changedPaths: string[] = [];
const FILE_VIEWER = {
  openFile,
  openGithubTab: () => {},
  isChangedPath: (p: string) => changedPaths.includes(p),
  conversationId: undefined as string | undefined,
  workspaceRoot: WORKSPACE as string | null,
  workspaceHome: "/home/u",
};

// Same shape, but with a live conversation id so the existence check can run
// (its query is disabled without one — exactly what the base fixture relies
// on to keep those tests network-free).
const FILE_VIEWER_WITH_SESSION = {
  ...FILE_VIEWER,
  conversationId: "conv_1",
};

function renderMarkdown(
  markdown: string,
  changed: string[] = [],
  viewer: typeof FILE_VIEWER = FILE_VIEWER,
  sourceItemId?: string,
  previewContext: ComponentProps<typeof AttachmentPreviewContext.Provider>["value"] = {},
): QueryClient {
  changedPaths = changed;
  openFile.mockClear();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <FileViewerContext.Provider value={viewer}>
        <TooltipProvider delayDuration={0}>
          <ConversationScopeContext.Provider value="conv_1">
            <AttachmentPreviewContext.Provider value={previewContext}>
              <FilePathAwareMessageResponse sourceItemId={sourceItemId}>
                {markdown}
              </FilePathAwareMessageResponse>
            </AttachmentPreviewContext.Provider>
          </ConversationScopeContext.Provider>
        </TooltipProvider>
      </FileViewerContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}

describe("implicit captured file references", () => {
  it("keeps menu placement and copied paths scoped to the message's originating chat", async () => {
    const openAttachment = vi.fn();
    const { metadataUrl, contentUrl } = mockCapturedReference({
      path: "/original/workspace/guide.txt",
      content: "Historical content",
    });
    renderMarkdown(
      "Read [the file](/original/workspace/guide.txt).",
      [],
      {
        ...FILE_VIEWER_WITH_SESSION,
        conversationId: "different-chat",
        workspaceRoot: "/different/workspace",
      },
      "original-item",
      { openAttachment },
    );
    const chip = await screen.findByRole("button", { name: "guide.txt" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      metadataUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fireEvent.contextMenu(chip);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith("/original/workspace/guide.txt"));
    fireEvent.contextMenu(chip);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open as tab" }));
    expect(openAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "conv_1",
        itemId: "original-item",
        reference: "/original/workspace/guide.txt",
      }),
      { placement: "tab" },
    );
    fireEvent.contextMenu(chip);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open beside chat" }));
    expect(openAttachment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "conv_1",
        itemId: "original-item",
        reference: "/original/workspace/guide.txt",
      }),
      { placement: "beside" },
    );
    expect(openFile).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => [metadataUrl, contentUrl].includes(url))).toBe(
      true,
    );
  });

  it.each([
    "Read [the file](/original/workspace/guide.txt).",
    "Read `/original/workspace/guide.txt:12`.",
  ])(
    "routes the source message into a dock preview after the active workspace changes: %s",
    async (markdown) => {
      const openAttachment = vi.fn();
      const { metadataUrl } = mockCapturedReference({
        path: "/original/workspace/guide.txt",
        content: "Historical content",
      });
      renderMarkdown(
        markdown,
        [],
        {
          ...FILE_VIEWER_WITH_SESSION,
          conversationId: "different-chat",
          workspaceRoot: "/different/workspace",
        },
        "original-item",
        { openAttachment },
      );
      fireEvent.click(await screen.findByRole("button", { name: "guide.txt" }));
      expect(openAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "conv_1",
          itemId: "original-item",
          reference: "/original/workspace/guide.txt",
        }),
        { placement: "default" },
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(openFile).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        metadataUrl,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );

  it.each([
    [400, "Not a file"],
    [403, "Owner access required"],
    [404, "File not found"],
    [409, "This message has no captured workspace"],
    [503, "Original host is offline"],
  ])("keeps an example/directory as code after a %s resolver response", async (status, detail) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = renderMarkdown(
      "Use `/projects/frontend` as an example.",
      [],
      FILE_VIEWER_WITH_SESSION,
      "captured-item",
    );
    expect(screen.getByText("/projects/frontend").tagName).toBe("CODE");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.getByText("/projects/frontend").tagName).toBe("CODE");
    expect(screen.queryByTestId("chat-attachment")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/sessions/conv_1/attachments/references/captured-item/metadata?path=%2Fprojects%2Ffrontend",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each(["file", "captured"] as const)(
    "waits for a %s reference and never substitutes the currently viewed workspace",
    async (kind) => {
      const { metadataUrl, contentUrl } = mockCapturedReference({
        path: "/original/workspace/guide.txt",
        content: "Original file contents",
        kind,
      });
      let resolve!: (response: Response) => void;
      fetchMock.mockReturnValueOnce(
        new Promise<Response>((done) => {
          resolve = done;
        }),
      );
      renderMarkdown(
        "Read `/original/workspace/guide.txt:12`.",
        [],
        {
          ...FILE_VIEWER_WITH_SESSION,
          conversationId: "different-chat",
          workspaceRoot: "/different/workspace",
        },
        "original-item",
      );
      expect(screen.getByText("/original/workspace/guide.txt:12").tagName).toBe("CODE");
      expect(screen.queryByRole("button")).toBeNull();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      resolve(referenceMetadata("/original/workspace/guide.txt", kind));
      const chip = await screen.findByRole("button", { name: "guide.txt" });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        metadataUrl,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      fireEvent.click(chip);
      await waitFor(() =>
        expect(screen.getByRole("dialog")).toHaveTextContent("Original file contents"),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledWith(
        contentUrl,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(openFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "directory", markdown: "Read `/projects/frontend`." },
    { kind: "directory", markdown: "Read [the folder](/projects/frontend)." },
    { kind: "missing", markdown: "Read `/projects/frontend`." },
    { kind: "missing", markdown: "Read [the file](/projects/frontend)." },
  ] as const)("keeps $kind metadata as quiet code: $markdown", async ({ kind, markdown }) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (
        url !==
        "/v1/sessions/conv_1/attachments/references/captured-item/metadata?path=%2Fprojects%2Ffrontend"
      )
        throw new Error(`Unexpected reference request: ${url}`);
      return referenceMetadata("/projects/frontend", kind);
    });
    const client = renderMarkdown(markdown, [], FILE_VIEWER_WITH_SESSION, "captured-item");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.getByText("/projects/frontend").tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps an inaccessible explicit captured Markdown link as quiet code", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Owner access required" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = renderMarkdown(
      "[Open file](/projects/frontend)",
      [],
      FILE_VIEWER_WITH_SESSION,
      "captured-item",
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.getByText("/projects/frontend").tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toastMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });
});

describe("markdown links to workspace files", () => {
  it.each([
    "See [Read the instructions](/original/workspace/AGENTS.md).",
    "See `/original/workspace/AGENTS.md:12`.",
  ])(
    "renders captured references inline and opens their original message scope: %s",
    async (markdown) => {
      const { metadataUrl, contentUrl } = mockCapturedReference({
        path: "/original/workspace/AGENTS.md",
        content: "# Captured instructions",
        contentType: "text/markdown",
      });
      renderMarkdown(markdown, [], FILE_VIEWER_WITH_SESSION, "original-item");
      const chip = await screen.findByRole("button", { name: "AGENTS.md" });
      expect(chip).toHaveTextContent(/^AGENTS\.md$/);
      expect(chip.querySelectorAll("svg")).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        metadataUrl,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      fireEvent.focus(chip);
      expect(await screen.findByRole("tooltip")).toHaveTextContent("/original/workspace/AGENTS.md");
      fireEvent.click(chip);
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          contentUrl,
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(openFile).not.toHaveBeenCalled();
    },
  );

  it("renders stored file links inline while retaining the stored file identity", async () => {
    const openAttachment = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "stored.pdf",
          metadata: { bytes: 12, content_type: "application/pdf" },
        }),
      ),
    );
    renderMarkdown(
      "Read [the report](/v1/sessions/conv_1/resources/files/original-file/content).",
      [],
      FILE_VIEWER_WITH_SESSION,
      "original-item",
      { openAttachment },
    );
    const chip = await screen.findByRole("button", { name: "stored.pdf" });
    expect(chip).toHaveClass("inline-flex", "align-baseline");
    expect(screen.queryByRole("button", { name: "Download stored.pdf" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/sessions/conv_1/resources/files/original-file",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fireEvent.click(chip);
    expect(openAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "conv_1",
        itemId: "original-item",
        filename: "stored.pdf",
        attachment: { file_id: "original-file", filename: "the report" },
      }),
      { placement: "default" },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/content"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/attachments/references/"))).toBe(
      false,
    );
  });
  it("plays an existing root-level recording outside the changed-file list", async () => {
    fetchMock.mockResolvedValue(dirListing(["demo.webm"]));
    renderMarkdown("[Screen recording](demo.webm)", [], FILE_VIEWER_WITH_SESSION);

    expect(
      await screen.findByRole("button", { name: "Play video: Screen recording" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Screen recording" }));
    expect(openFile).toHaveBeenCalledWith("demo.webm");
  });

  it("renders a workspace recording inline and keeps its file-viewer link", () => {
    renderMarkdown("[Screen recording](demo.webm)", ["demo.webm"], FILE_VIEWER_WITH_SESSION);
    expect(screen.getByRole("button", { name: "Play video: Screen recording" })).toBeVisible();
    expect(screen.getAllByText("Screen recording")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Screen recording" }));
    expect(openFile).toHaveBeenCalledWith("demo.webm");
  });

  it("renders direct remote video links but leaves ordinary links alone", () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    renderMarkdown(
      "[Demo](https://example.com/demo.mp4?signature=abc) and [docs](https://example.com/page)",
    );
    expect(document.querySelectorAll("video")).toHaveLength(0);
    const docs = screen.getByRole("link", { name: "docs" });
    expect(docs).toHaveAttribute("href", "https://example.com/page");
    expect(docs).toHaveAttribute("target", "_blank");
    fireEvent.click(screen.getByRole("button", { name: "Play video: Demo" }));
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(document.querySelector("video")).toHaveAttribute(
      "src",
      "https://example.com/demo.mp4?signature=abc",
    );
    expect(screen.getByRole("link", { name: "docs" })).toBe(docs);
    expect(openFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the FileViewer for an absolute path instead of navigating", () => {
    renderMarkdown(`[proposal.md](${WORKSPACE}/docs/proposal.md)`, ["docs/proposal.md"]);

    const link = screen.getByRole("button", { name: "proposal.md" });
    // No href at all: the parked fragment must not survive as clickable.
    expect(link).not.toHaveAttribute("href");

    fireEvent.click(link);
    expect(openFile).toHaveBeenCalledWith("docs/proposal.md");
  });

  it("opens the FileViewer for a relative path instead of showing it as blocked", () => {
    renderMarkdown("[notes.md](docs/notes.md)", ["docs/notes.md"]);

    expect(screen.queryByText(/\[blocked\]/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "notes.md" }));
    expect(openFile).toHaveBeenCalledWith("docs/notes.md");
  });

  it("opens on keyboard activation", () => {
    renderMarkdown("[notes.md](docs/notes.md)", ["docs/notes.md"]);

    fireEvent.keyDown(screen.getByRole("button", { name: "notes.md" }), { key: "Enter" });
    expect(openFile).toHaveBeenCalledWith("docs/notes.md");
  });

  it("preserves a root-level filename with a cited line through sanitization", () => {
    renderMarkdown("[README.md](README.md:12:3)", ["README.md"]);

    expect(screen.queryByText(/\[blocked\]/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    expect(openFile).toHaveBeenCalledWith("README.md", { line: 12, column: 3 });
  });

  it("leaves an external link as a real anchor", () => {
    renderMarkdown("[docs](https://example.com/page)");

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/page");
  });

  it("adds a PR icon while preserving descriptive link text and its destination", () => {
    const href = "https://github.com/acme/app/pull/42#discussion_r123";
    renderMarkdown(`[Fix rendering](${href})`);

    const link = screen.getByRole("link", { name: "Fix rendering" });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("title", href);
    expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("shortens an autolinked PR URL without changing its destination", () => {
    const href = "https://github.com/acme/app/pull/42";
    renderMarkdown(href);

    expect(screen.getByRole("link", { name: "app#42" })).toHaveAttribute("href", href);
  });

  it("preserves formatting and surrounding prose in a descriptive PR link", () => {
    const href = "https://github.com/acme/app/pull/42";
    renderMarkdown(`See [**Fix** rendering on narrow screens](${href}) before merging.`);

    const link = screen.getByRole("link", { name: "Fix rendering on narrow screens" });
    expect(link).toHaveAttribute("href", href);
    expect(link.querySelector('[data-streamdown="strong"]')).toHaveTextContent("Fix");
    expect(link.parentElement).toHaveTextContent(
      "See Fix rendering on narrow screens before merging.",
    );
  });

  it.each([
    "https://github.com/acme/app/pull/42/files",
    "https://github.com.example.com/acme/app/pull/42",
    "https://example.com/acme/app/pull/42",
  ])("preserves ordinary URL labels for %s", (href) => {
    renderMarkdown(href);

    const link = screen.getByRole("link", { name: href });
    expect(link).toHaveAttribute("href", href);
    expect(link.querySelector("svg")).toBeNull();
  });

  it("keeps Streamdown's link styling on external links", () => {
    renderMarkdown("[docs](https://example.com/page)");
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("data-streamdown", "link");
    expect(link).toHaveClass("wrap-anywhere", "font-medium", "text-link", "underline");
  });

  it("renders local links as baseline chips with a descriptive file icon", () => {
    renderMarkdown("See [notes.md](docs/notes.md).", ["docs/notes.md"]);
    const link = screen.getByRole("button", { name: "notes.md" });
    expect(link).toHaveAttribute("data-streamdown", "link");
    expect(link).toHaveClass("inline-flex", "align-baseline", "items-baseline");
    expect(link.querySelector("svg")).toHaveAttribute("data-file-type", "document");
    expect(link.querySelectorAll("svg")).toHaveLength(1);
    expect(link).not.toHaveAttribute("title");
  });

  it("keeps the source hast node out of the DOM", () => {
    // Streamdown passes `node` to every override; spreading it onto the element
    // renders a literal node="[object Object]" attribute.
    renderMarkdown("[docs](https://example.com/page) and `docs/notes.md`", ["docs/notes.md"]);

    expect(screen.getByRole("link", { name: "docs" })).not.toHaveAttribute("node");
    expect(screen.getByText("docs/notes.md")).not.toHaveAttribute("node");
  });

  it("renders a path that names no workspace file as plain text, not a dead link", () => {
    // Not in the changed list and no conversation id, so no existence check can
    // confirm it, so it must not become an anchor on the parked fragment.
    renderMarkdown("[ghost.md](docs/ghost.md)");

    expect(screen.queryByRole("link", { name: "ghost.md" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ghost.md" })).toBeNull();
    expect(screen.getByText("ghost.md")).toBeInTheDocument();
    expect(screen.queryByText(/\[blocked\]/)).toBeNull();
  });

  it("keeps inline paths without captured-message provenance as code even when currently changed", () => {
    renderMarkdown("see `docs/notes.md` for detail", ["docs/notes.md"]);
    expect(screen.getByText("docs/notes.md").tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });
});

// A markdown link destination is a URL, so a filename with spaces arrives
// percent-encoded (`My%20Notes.md`). The stored path must be the real filename
// — but an encoded `#` or `:` in a filename must never be decoded into citation
// syntax, or the opener would open the sibling `report.md` at line 12 instead.
describe("percent-encoded file links", () => {
  it("opens a link whose filename has spaces", () => {
    renderMarkdown("[notes](docs/My%20Notes.md)", ["docs/My Notes.md"]);

    fireEvent.click(screen.getByRole("button", { name: "notes" }));
    expect(openFile).toHaveBeenCalledWith("docs/My Notes.md");
  });

  it("opens a link whose filename has spaces at its cited line", () => {
    renderMarkdown("[notes](docs/My%20Notes.md#L12)", ["docs/My Notes.md"]);

    fireEvent.click(screen.getByRole("button", { name: "notes" }));
    expect(openFile).toHaveBeenCalledWith("docs/My Notes.md", { line: 12 });
  });

  it.each([
    ["docs/report.md%23L12", "docs/report.md#L12"],
    ["docs/report.md%3A12", "docs/report.md:12"],
  ])("never opens the sibling of a literal filename linked as %s", (href, literal) => {
    // Both the literal filename and the file a decoded citation would point at
    // exist. Opening `docs/report.md` at line 12 here would be the wrong file.
    renderMarkdown(`[report](${href})`, ["docs/report.md", literal]);

    expect(screen.queryByRole("button", { name: "report" })).toBeNull();
    expect(screen.getByText("report")).toBeInTheDocument();
    expect(openFile).not.toHaveBeenCalled();
  });
});

// Agents emit both compiler-style `path:line[:column]` and source-link-style
// `path#Lline[-Lend]` citations. Every path presentation supported by chat must
// preserve the first cited line while still resolving to a workspace-relative
// filename.
describe("cited positions", () => {
  it.each([
    ["relative colon", "`docs/notes.md:12`", "docs/notes.md:12", "docs/notes.md", 12],
    ["relative line+column", "`docs/notes.md:12:7`", "docs/notes.md:12:7", "docs/notes.md", 12, 7],
    ["relative hash line", "`docs/notes.md#L13`", "docs/notes.md#L13", "docs/notes.md", 13],
    [
      "relative hash line+column",
      "`docs/notes.md#L14C3`",
      "docs/notes.md#L14C3",
      "docs/notes.md",
      14,
      3,
    ],
    [
      "absolute",
      `\`${WORKSPACE}/docs/notes.md:16\``,
      `${WORKSPACE}/docs/notes.md:16`,
      "docs/notes.md",
      16,
    ],
    ["home-relative", "`~/ws/docs/notes.md#L17`", "~/ws/docs/notes.md#L17", "docs/notes.md", 17],
    [
      "root basename",
      `\`${WORKSPACE}/README.md#L18\``,
      `${WORKSPACE}/README.md#L18`,
      "README.md",
      18,
    ],
  ])(
    "keeps an uncaptured inline-code %s citation intact",
    (_label, markdown, name, path, _line, _column?: number) => {
      renderMarkdown(markdown, [path]);
      expect(screen.getByText(name).tagName).toBe("CODE");
      expect(screen.queryByRole("button")).toBeNull();
      expect(openFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["relative colon", "docs/notes.md:21", "docs/notes.md", 21],
    ["absolute hash line", `${WORKSPACE}/docs/notes.md#L23`, "docs/notes.md", 23],
    ["home-relative line+column", "~/ws/docs/notes.md:24:9", "docs/notes.md", 24, 9],
    ["file URI hash line", `file://${WORKSPACE}/docs/notes.md#L25`, "docs/notes.md", 25],
  ])(
    "opens a markdown %s citation at its first line",
    (_label, href, path, line, column?: number) => {
      renderMarkdown(`[target](${href})`, [path]);

      fireEvent.click(screen.getByRole("button", { name: "target" }));
      expect(openFile).toHaveBeenCalledWith(path, { line, ...(column ? { column } : {}) });
    },
  );

  it("opens an explicit path without a position as a plain open", () => {
    renderMarkdown("see [docs/notes.md](docs/notes.md) for detail", ["docs/notes.md"]);

    fireEvent.click(screen.getByRole("button", { name: "docs/notes.md" }));
    expect(openFile).toHaveBeenCalledWith("docs/notes.md");
  });

  it.each(["docs/notes.md:0", "docs/notes.md#L0"])(
    "degrades an invalid zero position to a plain open: %s",
    (citation) => {
      renderMarkdown(`[${citation}](${citation})`, ["docs/notes.md"]);
      fireEvent.click(screen.getByRole("button", { name: citation }));
      expect(openFile).toHaveBeenCalledWith("docs/notes.md");
    },
  );

  it.each([
    "docs/notes.md:abc",
    "docs/notes.md#heading",
    "docs/notes.md#Lx",
    "docs/notes.md?line=12",
  ])("leaves an unsupported suffix inert: %s", (citation) => {
    renderMarkdown(`[${citation}](${citation})`, ["docs/notes.md"]);
    expect(screen.queryByRole("button", { name: citation })).toBeNull();
  });
});

// Agents cite a span of lines as `path:start-end` or `path#Lstart-Lend`; both
// must link and open the file with the whole range, not just its first line.
describe("cited line ranges", () => {
  const SCALA = "sql/core/SQLFunctionExpression.scala";

  it.each([
    ["colon", `${SCALA}:68-72`],
    ["hash", `${SCALA}#L68-L72`],
    ["absolute colon", `${WORKSPACE}/${SCALA}:68-72`],
  ])("keeps an uncaptured inline-code %s range intact", (_label, citation) => {
    renderMarkdown(`see \`${citation}\``, [SCALA]);
    expect(screen.getByText(citation).tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
  });

  it.each([
    ["colon", "docs/notes.md:22-30"],
    ["hash", "docs/notes.md#L22-L30"],
    ["root basename colon", "notes.md:22-30"],
  ])("opens a markdown %s range with its first and last line", (_label, href) => {
    const path = href.startsWith("docs/") ? "docs/notes.md" : "notes.md";
    renderMarkdown(`[target](${href})`, [path]);

    expect(screen.queryByText(/\[blocked\]/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "target" }));
    expect(openFile).toHaveBeenCalledWith(path, { line: 22, endLine: 30 });
  });

  it("keeps a backwards range openable at its first line", () => {
    renderMarkdown("[docs/notes.md:30-22](docs/notes.md:30-22)", ["docs/notes.md"]);

    fireEvent.click(screen.getByRole("button", { name: "docs/notes.md:30-22" }));
    expect(openFile).toHaveBeenCalledWith("docs/notes.md", { line: 30 });
  });
});

// File chips show the target filename; citations still control the viewer position.
describe("file link labels", () => {
  it("labels an inline-code file link by its filename and exposes its full path on focus", async () => {
    const citation = `${WORKSPACE}/sql/core/SQLFunctionExpression.scala:68-72`;
    const { metadataUrl } = mockCapturedReference({
      path: `${WORKSPACE}/sql/core/SQLFunctionExpression.scala`,
      content: "class Example",
    });
    renderMarkdown(
      `see \`${citation}\``,
      ["sql/core/SQLFunctionExpression.scala"],
      FILE_VIEWER_WITH_SESSION,
      "original-item",
    );

    const link = await screen.findByRole("button", { name: "SQLFunctionExpression.scala" });
    expect(link).toHaveTextContent(/^SQLFunctionExpression\.scala$/);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      metadataUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(link).not.toHaveAttribute("title");
    fireEvent.focus(link);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      `${WORKSPACE}/sql/core/SQLFunctionExpression.scala`,
    );
  });

  it("leaves a bare file name and a non-openable path as written", () => {
    renderMarkdown("`README.md` and `docs/ghost.md`", ["README.md"]);

    expect(screen.getByText("README.md").tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("docs/ghost.md").tagName).toBe("CODE");
  });

  it("shortens markdown link text that spells out the linked path", () => {
    renderMarkdown("[docs/notes.md:12](docs/notes.md#L12)", ["docs/notes.md"]);

    const link = screen.getByRole("button", { name: "docs/notes.md:12" });
    expect(link).toHaveTextContent(/^notes\.md$/);
    expect(link).not.toHaveAttribute("title");
    fireEvent.click(link);
    expect(openFile).toHaveBeenCalledWith("docs/notes.md", { line: 12 });
  });

  it("shortens a path label without a position on a link to a cited line", () => {
    renderMarkdown("[docs/notes.md](docs/notes.md#L12)", ["docs/notes.md"]);

    const link = screen.getByRole("button", { name: "docs/notes.md" });
    expect(link).toHaveTextContent(/^notes\.md$/);
    fireEvent.click(link);
    expect(openFile).toHaveBeenCalledWith("docs/notes.md", { line: 12 });
  });

  it.each([
    ["a descriptive label", "[the migration notes](docs/notes.md)", "the migration notes"],
    ["a path to another file", "[docs/other.md](docs/notes.md)", "docs/other.md"],
    ["a same-named file elsewhere", "[src/a/notes.md](docs/notes.md)", "src/a/notes.md"],
    ["text citing another line", "[docs/notes.md:10](docs/notes.md#L50)", "docs/notes.md:10"],
    [
      "text citing another column",
      "[docs/notes.md:12:5](docs/notes.md#L12C9)",
      "docs/notes.md:12:5",
    ],
  ])(
    "shows the target filename while retaining %s as its accessible label",
    (_label, markdown, text) => {
      renderMarkdown(markdown, ["docs/notes.md"]);

      const link = screen.getByRole("button", { name: text });
      expect(link).toHaveTextContent(/^notes\.md$/);
      expect(link).toHaveAttribute("aria-label", text);
    },
  );
});

// Files OUTSIDE the workspace root. The FileViewer and filesystem API open
// host-absolute paths (the files panel's browse-anywhere plumbing), so an
// agent-cited outside file must linkify once its existence is confirmed —
// before this, such links dropped to dead text that did nothing when
// clicked, and gave a touch user (no hover title) no feedback at all.
describe("links to files outside the workspace", () => {
  it("renders the absolute temporary-file link from the reported Codex output", async () => {
    const path = "/tmp/liteswap-search-OiTI1v/prod-recent-candidate-owner.md";
    fetchMock.mockResolvedValue(dirListing([path]));
    renderMarkdown(`[Investigation details](${path})`, [], FILE_VIEWER_WITH_SESSION);

    fireEvent.click(await screen.findByRole("button", { name: "Investigation details" }));
    expect(openFile).toHaveBeenCalledWith(path);
  });

  it("linkifies an outside-workspace markdown link and opens it host-absolute", async () => {
    fetchMock.mockResolvedValue(dirListing(["/etc/hosts"]));
    renderMarkdown("[/etc/hosts](/etc/hosts)", [], FILE_VIEWER_WITH_SESSION);

    const link = await screen.findByRole("button", { name: "/etc/hosts" });
    // The existence check listed the ABSOLUTE parent via base=host — never a
    // leading %2F that a slash-merging proxy would collapse.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/filesystem/etc?");
    expect(url).toContain("base=host");

    fireEvent.click(link);
    expect(openFile).toHaveBeenCalledWith("/etc/hosts");
  });

  it("does not probe an uncaptured inline-code path against the currently active host", () => {
    renderMarkdown("see `/etc/hosts` for the mapping", [], FILE_VIEWER_WITH_SESSION);
    expect(screen.getByText("/etc/hosts").tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("resolves an outside-workspace home-relative path through the runner home", async () => {
    fetchMock.mockResolvedValue(dirListing(["/home/u/other/notes.md"]));
    renderMarkdown("[notes](~/other/notes.md)", [], FILE_VIEWER_WITH_SESSION);

    fireEvent.click(await screen.findByRole("button", { name: "notes" }));
    expect(openFile).toHaveBeenCalledWith("/home/u/other/notes.md");
  });
});

// A marked link that names no openable file. Silent inertness is only
// acceptable while the answer isn't known yet; once it is, the reference must
// explain itself when activated — on touch there is no hover title, so an
// inert span reads as "tapping does nothing".
describe("dead file links give feedback instead of a silent no-op", () => {
  it("explains a confirmed-missing link on click instead of doing nothing", async () => {
    // Parent listing exists but the file isn't in it → definitively absent.
    fetchMock.mockResolvedValue(dirListing(["/no/such/other.txt"]));
    renderMarkdown("[missing](/no/such/file.txt)", [], FILE_VIEWER_WITH_SESSION);

    const dead = await screen.findByRole("button", { name: "missing" });
    fireEvent.click(dead);
    expect(openFile).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(String(toastMock.mock.calls[0][0])).toContain("/no/such/file.txt");
  });

  it("explains on keyboard activation too", async () => {
    fetchMock.mockResolvedValue(dirListing([]));
    renderMarkdown("[missing](/no/such/file.txt)", [], FILE_VIEWER_WITH_SESSION);

    fireEvent.keyDown(await screen.findByRole("button", { name: "missing" }), { key: "Enter" });
    expect(openFile).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("stays inert (no feedback affordance) while the check is in flight", () => {
    // Never resolves → the answer isn't known; claiming "can't open" now
    // would be wrong for a file that's about to be confirmed.
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    renderMarkdown("[pending](/no/such/file.txt)", [], FILE_VIEWER_WITH_SESSION);

    expect(screen.queryByRole("button", { name: "pending" })).toBeNull();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("verifies and opens an explicit root-level file citation", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [{ name: "README.md", path: "README.md", type: "file", bytes: 5 }],
        has_more: false,
      }),
    );
    renderMarkdown("[README.md](README.md:12)", [], FILE_VIEWER_WITH_SESSION);

    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    expect(openFile).toHaveBeenCalledWith("README.md", { line: 12 });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("stays inert when the parent listing errors — an error is not proof of absence", async () => {
    // A transient 500 (or gateway/network failure) must degrade to plain
    // text, not declare an otherwise-openable file permanently dead.
    fetchMock.mockResolvedValue(jsonResponse({ error: {} }, 500));
    renderMarkdown("[maybe](/outside/dir/file.txt)", [], FILE_VIEWER_WITH_SESSION);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "maybe" })).toBeNull();
    expect(screen.getByText("maybe")).toBeInTheDocument();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("stays inert for an absolute link while the workspace root is still unknown", () => {
    // Until the environment metadata loads, inside/outside the workspace
    // can't be told apart. That window is "not verified yet", never "known
    // dead" — the link self-heals once the root arrives.
    renderMarkdown("[hosts](/etc/hosts)", [], {
      ...FILE_VIEWER_WITH_SESSION,
      workspaceRoot: null,
    });

    expect(screen.queryByRole("button", { name: "hosts" })).toBeNull();
    expect(screen.getByText("hosts")).toBeInTheDocument();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("explains a hard-rejected path without claiming it wasn't found", async () => {
    // Traversal segments are rejected by the resolver — the filesystem was
    // never searched — so the feedback must say the path doesn't resolve,
    // not assert the file is missing.
    renderMarkdown(`[trap](${WORKSPACE}/../../etc/hosts)`, [], FILE_VIEWER_WITH_SESSION);

    const dead = await screen.findByRole("button", { name: "trap" });
    fireEvent.click(dead);
    expect(openFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    const message = String(toastMock.mock.calls[0][0]);
    expect(message).toContain("doesn't resolve");
    expect(message).not.toContain("wasn't found");
  });
});

// A file link carries no href, so neither the browser nor the desktop shell
// offers "Copy Link Address" for it. Its own menu copies the path it names,
// host-absolute so it still resolves when pasted into another session.
describe("copying a file link's path", () => {
  async function copyFromMenu(link: HTMLElement): Promise<void> {
    fireEvent.contextMenu(link);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1));
  }

  it.each([
    ["an absolute href", `${WORKSPACE}/docs/handoff.md`],
    ["a relative href", "docs/handoff.md"],
    ["a cited line", "docs/handoff.md:21"],
    ["a home-relative href", "~/ws/docs/handoff.md"],
  ])("copies the host-absolute path of a link with %s", async (_label, href) => {
    renderMarkdown(`[Handoff](${href})`, ["docs/handoff.md"]);

    await copyFromMenu(screen.getByRole("button", { name: "Handoff" }));
    expect(copyTextMock).toHaveBeenCalledWith(`${WORKSPACE}/docs/handoff.md`);
    expect(openFile).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Copied path"));
  });

  it("copies a relative path as written while the workspace root is unknown", async () => {
    renderMarkdown("[Handoff](docs/handoff.md)", ["docs/handoff.md"], {
      ...FILE_VIEWER,
      workspaceRoot: null,
    });

    await copyFromMenu(screen.getByRole("button", { name: "Handoff" }));
    expect(copyTextMock).toHaveBeenCalledWith("docs/handoff.md");
  });

  it("copies an unverified link's path", async () => {
    renderMarkdown("[ghost.md](docs/ghost.md)");

    await copyFromMenu(screen.getByText("ghost.md"));
    expect(copyTextMock).toHaveBeenCalledWith(`${WORKSPACE}/docs/ghost.md`);
  });

  it("copies a confirmed-missing link's path", async () => {
    fetchMock.mockResolvedValue(dirListing(["/no/such/other.txt"]));
    renderMarkdown("[missing](/no/such/file.txt)", [], FILE_VIEWER_WITH_SESSION);

    await copyFromMenu(await screen.findByRole("button", { name: "missing" }));
    expect(copyTextMock).toHaveBeenCalledWith("/no/such/file.txt");
  });

  it("copies an unresolvable path as written", async () => {
    renderMarkdown(`[trap](${WORKSPACE}/../../etc/hosts)`);

    await copyFromMenu(screen.getByRole("button", { name: "trap" }));
    expect(copyTextMock).toHaveBeenCalledWith(`${WORKSPACE}/../../etc/hosts`);
  });

  it("reports a failed copy", async () => {
    copyTextMock.mockRejectedValue(new Error("denied"));
    renderMarkdown("[Handoff](docs/handoff.md)", ["docs/handoff.md"]);

    await copyFromMenu(screen.getByRole("button", { name: "Handoff" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't copy the path"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("leaves the native menu on an external link", () => {
    renderMarkdown("[docs](https://example.com/page)");

    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.contextMenu(screen.getByRole("link", { name: "docs" }))).toBe(true);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
