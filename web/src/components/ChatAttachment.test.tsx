// Modified for Triune.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AttachmentPreviewContext,
  AttachmentPreviewView,
  ChatAttachment,
  type AttachmentPreviewRequest,
} from "./ChatAttachment";
import { ImageLightboxProvider } from "./ImageLightbox";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ComponentProps, ReactNode } from "react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), download: vi.fn(), copy: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("@/lib/explorerOperations", () => ({ downloadBlob: mocks.download }));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copy }));
vi.mock("@/shell/PdfViewer", () => ({ PdfViewer: () => <p>PDF document preview</p> }));
vi.mock("@/shell/CodeViewer", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <article>{content}</article>,
}));
beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.download.mockReset();
  mocks.copy.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:attachment"),
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(
  filename: string,
  mime: string,
  content: string,
  props: Partial<ComponentProps<typeof ChatAttachment>> = {},
  previewContext: ComponentProps<typeof AttachmentPreviewContext.Provider>["value"] = {},
) {
  mocks.fetch.mockImplementation(async (url: string) =>
    url.includes("/metadata?")
      ? new Response(
          JSON.stringify({
            kind: "file",
            path: filename,
            workspace: { id: "source-workspace", root: "/original/workspace" },
          }),
        )
      : url.endsWith("/content") || url.includes("/attachments/references/")
        ? new Response(content, { headers: { "Content-Type": mime } })
        : new Response(JSON.stringify({ metadata: { bytes: content.length, content_type: mime } })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <ImageLightboxProvider>
          <AttachmentPreviewContext.Provider value={previewContext}>
            {children}
          </AttachmentPreviewContext.Provider>
        </ImageLightboxProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(
    wrap(
      <ChatAttachment
        sessionId="original-chat"
        attachment={{ file_id: "file-id", filename }}
        {...props}
      />,
    ),
  );
  return {
    client,
    ...view,
    showPreview: (request: AttachmentPreviewRequest) =>
      view.rerender(wrap(<AttachmentPreviewView request={request} />)),
  };
}
it("loads images through authenticated storage URLs and downloads the original", async () => {
  mount("chart ü.png", "image/png", "original-bytes");
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "chart ü.png" })).toHaveAttribute(
      "src",
      "blob:attachment",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download chart ü.png" }));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledWith(expect.any(Blob), "chart ü.png"));
  expect(mocks.fetch).toHaveBeenCalledWith(
    "/v1/sessions/original-chat/resources/files/file-id/content",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it.each([
  [1600, 800, 512],
  [600, 1200, 128],
  [400, 100, 400],
])(
  "fits the image card to its %sx%s preview while preserving full-size lightbox content",
  async (width, height, fittedWidth) => {
    mount("chart ü.png", "image/png", "original-bytes");
    const img = await screen.findByRole("img", { name: "chart ü.png" });
    Object.defineProperties(img, {
      naturalWidth: { value: width },
      naturalHeight: { value: height },
    });
    fireEvent.load(img);
    const card = screen.getByTestId("chat-attachment");
    expect(card).toHaveStyle({ width: `calc(${fittedWidth}px + 1.5rem + 2px)` });
    expect(card).toHaveClass("max-w-[min(100%,640px)]");
    expect(img).toHaveClass("w-full", "h-auto", "max-h-64");
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: chart ü.png" }));
    const original = within(screen.getByRole("dialog")).getByRole("img", { name: "chart ü.png" });
    expect(original).toHaveAttribute("src", img.getAttribute("src"));
    expect(original).not.toHaveClass("max-h-64");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(original).toHaveStyle({ transform: "translate(0px, 0px) scale(1.5)" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.error(img);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be decoded");
    expect(card.style.width).toBe("");
  },
);

it("keeps local references filename-only and fetches their captured message only on activation", async () => {
  const reference = "/original/workspace/docs/My notes.md";
  mount("My notes.md", "text/markdown", "# Original workspace", {
    attachment: undefined,
    compact: true,
    reference,
    itemId: "source/item",
  });
  const chip = await screen.findByRole("button", { name: "My notes.md" });
  expect(chip).toHaveClass("inline-flex", "align-baseline", "items-baseline");
  expect(chip).not.toHaveAttribute("title");
  expect(chip.querySelectorAll("svg")).toHaveLength(1);
  expect(chip.querySelector("svg")).toHaveAttribute("data-file-type", "document");
  expect(mocks.fetch.mock.calls.every(([url]) => url.includes("/metadata?"))).toBe(true);
  fireEvent.focus(chip);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(reference);
  fireEvent.click(chip);
  expect(await screen.findByRole("article")).toHaveTextContent("Original workspace");
  expect(mocks.fetch).toHaveBeenCalledWith(
    `/v1/sessions/original-chat/attachments/references/source%2Fitem?${new URLSearchParams({ path: reference })}`,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(screen.getByRole("dialog")).toHaveTextContent("Download original");
  expect(screen.getByRole("dialog")).toHaveClass(
    "w-[calc(100vw-1rem)]",
    "max-h-[90dvh]",
    "sm:max-w-4xl",
  );
  expect(screen.getByRole("dialog")).not.toHaveClass("sm:max-w-sm");
});

it("routes compact file activation beside its chat with immutable identity", async () => {
  const openAttachment = vi.fn();
  const { showPreview } = mount(
    "report.txt",
    "text/plain",
    "Captured original",
    { compact: true },
    { openAttachment },
  );
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "report.txt" }));
  expect(openAttachment).toHaveBeenCalledOnce();
  expect(openAttachment.mock.calls[0][1]).toEqual({ placement: "default" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.fetch.mock.calls.every(([url]) => !url.endsWith("/content"))).toBe(true);
  const request = openAttachment.mock.calls[0][0];
  expect(request).toMatchObject({
    sessionId: "original-chat",
    attachment: { file_id: "file-id", filename: "report.txt" },
  });
  showPreview(request);
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Preview report.txt" })).toHaveTextContent(
      "Captured original",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  expect(await mocks.download.mock.calls[0][0].text()).toBe("Captured original");
  expect(mocks.fetch).toHaveBeenCalledWith(
    "/v1/sessions/original-chat/resources/files/file-id/content",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it("opens a full attachment in the large modal even when docking is available", async () => {
  const openAttachment = vi.fn();
  mount("report.txt", "text/plain", "Captured original", {}, { openAttachment });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "report.txt" }));
  const modal = await screen.findByRole("dialog");
  await waitFor(() => expect(modal).toHaveTextContent("Captured original"));
  expect(modal).toHaveClass("sm:max-w-4xl", "w-[calc(100vw-1rem)]");
  expect(openAttachment).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps captured reference bytes and the origin message when moving from chat to a dock preview", async () => {
  const openAttachment = vi.fn();
  const reference = "/original/workspace/notes.txt";
  const { showPreview } = mount(
    "notes.txt",
    "text/plain",
    "Historical bytes",
    {
      attachment: undefined,
      compact: true,
      reference,
      itemId: "source/item",
      unresolvedFallback: <code>{reference}</code>,
    },
    { openAttachment },
  );
  const chip = await screen.findByRole("button", { name: "notes.txt" });
  expect(mocks.fetch).toHaveBeenCalledOnce();
  fireEvent.click(chip);
  const request = JSON.parse(JSON.stringify(openAttachment.mock.calls[0][0]));
  expect(request).toMatchObject({ sessionId: "original-chat", itemId: "source/item", reference });
  showPreview(request);
  await waitFor(() => expect(screen.getByRole("region")).toHaveTextContent("Historical bytes"));
  mocks.fetch.mockResolvedValue(new Response("Source removed", { status: 404 }));
  showPreview(request);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Download notes.txt" }));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  expect(await mocks.download.mock.calls[0][0].text()).toBe("Historical bytes");
});

it.each(["context", "overflow"])(
  "shares placement, modal, captured Reveal, copy and download actions in the %s menu",
  async (menu) => {
    const openAttachment = vi.fn();
    const revealAttachment = vi.fn();
    const reference = "/original/workspace/notes.txt";
    mount(
      "notes.txt",
      "text/plain",
      "Historical bytes",
      { attachment: undefined, reference, itemId: "source/item" },
      { openAttachment, revealAttachment },
    );
    const user = userEvent.setup();
    const openMenu = async () => {
      if (menu === "overflow")
        await user.click(screen.getByRole("button", { name: "More actions for notes.txt" }));
      else fireEvent.contextMenu(screen.getByRole("button", { name: "notes.txt" }));
      await screen.findByRole("menuitem", { name: "Reveal in Explorer" });
    };
    await openMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "Open beside chat",
      "Open as tab",
      "Open in modal",
      "Reveal in Explorer",
      "Copy path",
      "Download original",
    ]);
    const choosePlacement = async (label: string, placement: string) => {
      await user.click(screen.getByRole("menuitem", { name: label }));
      expect(openAttachment).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "original-chat", itemId: "source/item", reference }),
        { placement },
      );
      await openMenu();
    };
    await choosePlacement("Open beside chat", "beside");
    await choosePlacement("Open as tab", "tab");
    await user.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(mocks.copy).toHaveBeenCalledWith(reference);
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Reveal in Explorer" }));
    expect(revealAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "original-chat", itemId: "source/item", reference }),
    );
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Download original" }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    expect(await mocks.download.mock.calls[0][0].text()).toBe("Historical bytes");
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Open in modal" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Historical bytes");
    expect(openAttachment).toHaveBeenCalledTimes(2);
  },
);

it.each(["ContextMenu", "F10"])("opens the inline action menu with %s", async (key) => {
  const openAttachment = vi.fn();
  mount("report.txt", "text/plain", "Original", { compact: true }, { openAttachment });
  const chip = screen.getByRole("button", { name: "report.txt" });
  chip.focus();
  fireEvent.keyDown(chip, { key, shiftKey: key === "F10" });
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole("menuitem", { name: "Open beside chat" })).toHaveFocus(),
  );
  await user.keyboard("{ArrowDown}{Enter}");
  expect(openAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "original-chat",
      attachment: { file_id: "file-id", filename: "report.txt" },
    }),
    { placement: "tab" },
  );
});

it("opens the same inline menu on touch long press without docking", async () => {
  const openAttachment = vi.fn();
  mount("report.txt", "text/plain", "Original", { compact: true }, { openAttachment });
  const chip = screen.getByRole("button", { name: "report.txt" });
  fireEvent.pointerDown(chip, { pointerType: "touch", pointerId: 1 });
  expect(
    await screen.findByRole("menuitem", { name: "Open as tab" }, { timeout: 1500 }),
  ).toBeVisible();
  fireEvent.pointerUp(chip, { pointerType: "touch", pointerId: 1 });
  fireEvent.click(chip);
  expect(openAttachment).not.toHaveBeenCalled();
});

it("hides unsupported placements and non-filesystem actions for stored attachments", async () => {
  const openAttachment = vi.fn();
  mount(
    "report.pdf",
    "application/pdf",
    "Original",
    { compact: true },
    {
      openAttachment,
      canOpenAttachment: (_request, placement) => placement === "tab",
      revealAttachment: vi.fn(),
    },
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "report.pdf" }));
  expect(await screen.findByRole("menuitem", { name: "Open as tab" })).toBeVisible();
  expect(screen.queryByRole("menuitem", { name: "Open beside chat" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Copy path" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Reveal in Explorer" })).toBeNull();
});

it("keeps pending uploads from offering open or download capabilities", async () => {
  const openAttachment = vi.fn();
  mount(
    "report.pdf",
    "application/pdf",
    "Original",
    { attachment: { file_id: "pending:upload", filename: "report.pdf" } },
    { openAttachment },
  );
  expect(screen.queryByRole("button", { name: "More actions for report.pdf" })).toBeNull();
  fireEvent.contextMenu(screen.getByRole("button", { name: "report.pdf" }));
  expect(screen.queryByRole("menuitem")).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Download report.pdf", hidden: true })).toBeDisabled();
});

it.each([true, false])(
  "offers Reveal only for a successfully authorized captured origin (allowed=%s)",
  async (allowed) => {
    const canRevealAttachment = vi.fn(() => allowed);
    const revealAttachment = vi.fn();
    const request = {
      sessionId: "original-chat",
      itemId: "original-item",
      reference: "/original/workspace/notes.txt",
    };
    const { showPreview } = mount(
      "notes.txt",
      "text/plain",
      "Historical bytes",
      { attachment: undefined, compact: true },
      { canRevealAttachment, revealAttachment },
    );
    showPreview(request);
    await waitFor(() => expect(screen.getByRole("region")).toHaveTextContent("Historical bytes"));
    const reveal = screen.queryByRole("button", { name: "Reveal in Explorer" });
    if (allowed) {
      expect(reveal).toBeInTheDocument();
      fireEvent.click(reveal!);
      expect(revealAttachment).toHaveBeenCalledWith(request);
      canRevealAttachment.mockReturnValue(false);
      fireEvent.click(reveal!);
      expect(revealAttachment).toHaveBeenCalledOnce();
    } else expect(reveal).toBeNull();
  },
);

it("delegates Reveal to the async origin lookup without requiring a synchronous availability check", async () => {
  const revealAttachment = vi.fn(async () => {});
  const request = {
    sessionId: "original-chat",
    itemId: "source/item",
    reference: "/original/workspace/notes.txt",
  };
  const { showPreview } = mount(
    "notes.txt",
    "text/plain",
    "Historical bytes",
    {
      attachment: undefined,
      compact: true,
    },
    { revealAttachment },
  );
  showPreview(request);
  fireEvent.click(await screen.findByRole("button", { name: "Reveal in Explorer" }));
  expect(revealAttachment).toHaveBeenCalledWith(request);
});

it("keeps denied captured previews actionable without exposing Reveal or a live-file fallback", async () => {
  const { showPreview } = mount(
    "notes.txt",
    "text/plain",
    "",
    { attachment: undefined, compact: true },
    { canRevealAttachment: () => true, revealAttachment: vi.fn() },
  );
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ detail: "Owner access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  );
  showPreview({
    sessionId: "original-chat",
    itemId: "original-item",
    reference: "/original/workspace/notes.txt",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Owner access required");
  expect(screen.queryByRole("button", { name: "Reveal in Explorer" })).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.fetch.mock.calls[0][0]).toContain(
    "/sessions/original-chat/attachments/references/original-item?",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  expect(mocks.fetch.mock.calls[1][0]).toBe(mocks.fetch.mock.calls[0][0]);
});

it("shows a compact metadata row with working overflow preview and original download", async () => {
  mount("report.pdf", "application/pdf", "original-pdf");
  expect(await screen.findByText("12 B")).toBeInTheDocument();
  expect(screen.getByText("application/pdf")).toBeInTheDocument();
  expect(
    screen.getByTestId("chat-attachment").querySelector("svg[data-file-type]"),
  ).toHaveAttribute("data-file-type", "pdf");
  expect(mocks.fetch.mock.calls.every(([url]) => !url.endsWith("/content"))).toBe(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "More actions for report.pdf" }));
  await user.click(screen.getByRole("menuitem", { name: "Open in modal" }));
  expect(await screen.findByText("PDF document preview")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledWith(expect.any(Blob), "report.pdf"));
});

it("keeps path and size beside one set of footer controls for a long reference", async () => {
  const reference = `/original/workspace/My notes ü/${"nested-directory/".repeat(12)}report.txt`;
  const content = "Original reference bytes";
  mount("report.txt", "text/plain", content, {
    attachment: undefined,
    reference,
    itemId: "source/item",
  });
  const details = screen.getByText(`${reference} · TXT`);
  expect(details).toBeInTheDocument();
  fireEvent.focus(details);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(reference);
  fireEvent.blur(details);
  expect(mocks.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "report.txt" }));
  await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent(content));
  const card = screen.getByTestId("chat-attachment");
  expect(within(card).getByText(`${reference} · text/plain`)).toBeInTheDocument();
  expect(within(card).getByText(`${content.length} B`)).not.toHaveTextContent("·");
  await userEvent.setup().keyboard("{Escape}");
  fireEvent.click(within(card).getByRole("button", { name: "Download report.txt" }));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  expect(await mocks.download.mock.calls[0][0].text()).toBe(content);
  expect(mocks.fetch).toHaveBeenCalledWith(
    `/v1/sessions/original-chat/attachments/references/source%2Fitem?${new URLSearchParams({ path: reference })}`,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it.each([
  ["notes.txt", "text/plain", "Original plain text"],
  ["app.ts", "text/typescript", "const original = 42;"],
  ["config.json", "application/json", '{"original":42}'],
  ["config.yaml", "application/yaml", "original: 42"],
  ["data.csv", "text/csv", "original,value\nfirst,42"],
])("preserves bounded text previews and exact downloads for %s", async (name, mime, text) => {
  mount(name, mime, text);
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(() =>
    expect(screen.getByRole("dialog").textContent?.replace(/\s/g, "")).toContain(
      text.replace(/\s/g, ""),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: `Download ${name}` }));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  expect(await mocks.download.mock.calls[0][0].text()).toBe(text);
});

it("retains rendered Markdown and its source toggle", async () => {
  mount("guide.md", "text/markdown", "# Original guide");
  fireEvent.click(screen.getByRole("button", { name: "guide.md" }));
  expect(await screen.findByRole("article")).toHaveTextContent("# Original guide");
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(screen.queryByRole("article")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(await screen.findByRole("article")).toHaveTextContent("# Original guide");
});
it("renders SVG only in an image element rather than inserting active markup", async () => {
  mount("unsafe.svg", "image/svg+xml", "<svg><script>window.pwned=true</script></svg>");
  await screen.findByRole("img", { name: "unsafe.svg" });
  expect(document.querySelector("script")).toBeNull();
});

it("closes an attachment lightbox with one Escape and retains its download name", async () => {
  const openAttachment = vi.fn();
  mount("chart ü.png", "image/png", "original-bytes", {}, { openAttachment });
  await screen.findByRole("img", { name: "chart ü.png" });
  const download = screen.getByRole("button", { name: "Download chart ü.png" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Zoom image: chart ü.png" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("150%");
  expect(openAttachment).not.toHaveBeenCalled();
  expect(download).toHaveAttribute("aria-label", "Download chart ü.png");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Download chart ü.png" })).toBeVisible();
});
it("isolates HTML with a sandbox and restrictive content policy, while retaining source", async () => {
  mount("page.html", "text/html", "<h1>hello</h1><script>parent.pwned=true</script>");
  fireEvent.click(screen.getByRole("button", { name: "page.html" }));
  const frame = await screen.findByTitle("page.html");
  expect(frame).toHaveAttribute("sandbox", "");
  expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(document.querySelector("iframe")).toBeNull();
  expect(screen.getByText("parent.pwned", { exact: false })).toBeInTheDocument();
});
it.each([
  ["sound.mp3", "audio/mpeg", "audio"],
  ["movie.mp4", "video/mp4", "video"],
])("plays browser media %s", async (name, mime, tag) => {
  mount(name, mime, "media");
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(() => expect(document.querySelector(tag)).toHaveAttribute("controls"));
});
it("keeps unsupported binary files downloadable with a clear fallback", async () => {
  mount("archive.zip", "application/zip", "PK-original");
  fireEvent.click(screen.getByRole("button", { name: "archive.zip" }));
  expect(await screen.findByText(/Preview is unavailable for this format/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Download archive.zip" }));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
});
it("reports a missing file without changing the target and retries explicitly", async () => {
  const { client } = mount("gone.png", "image/png", "old");
  await screen.findByRole("img", { name: "gone.png" });
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ detail: "File not found" }), { status: 404 }),
  );
  await act(async () => {
    await client.refetchQueries({ queryKey: ["chat-attachment-bytes"] });
  });
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent("File not found");
});
it("pins late image responses to the original file identity during chat reuse", async () => {
  const { rerender, client } = mount("old.png", "image/png", "old");
  await screen.findByRole("img");
  let finish!: (response: Response) => void;
  mocks.fetch.mockImplementation(async (url: string) =>
    url.endsWith("/content")
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : new Response(JSON.stringify({ metadata: { bytes: 3 } })),
  );
  rerender(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <ChatAttachment
          sessionId="other-chat"
          attachment={{ file_id: "other", filename: "new.png" }}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("img")).toBeNull();
  await act(async () => finish(new Response("new", { headers: { "Content-Type": "image/png" } })));
  await screen.findByRole("img", { name: "new.png" });
});

it.each([
  { filename: { name: "report.pdf" } },
  { file_id: 42 },
  { filename: 7, file_id: ["file_1"], image_url: { url: "bad" } },
])("keeps malformed imported attachment fields from breaking the message: %j", (attachment) => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ChatAttachment sessionId="original-chat" attachment={attachment as never} />
      <p>Other message text stays readable.</p>
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Attachment" })).toBeInTheDocument();
  expect(screen.getByText("Other message text stays readable.")).toBeInTheDocument();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
