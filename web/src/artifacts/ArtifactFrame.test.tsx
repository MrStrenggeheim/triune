// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactFrame } from "./ArtifactFrame";
import { TooltipProvider } from "@/components/ui/tooltip";
import userEvent from "@testing-library/user-event";
import { copyText } from "@/lib/clipboard";
import { downloadBlob } from "@/lib/explorerOperations";

const viewer = vi.hoisted(() => ({ id: "artifact-viewer-a" }));
vi.mock("@/hooks/useViewerId", () => ({ useViewerId: () => viewer.id }));
vi.mock("@/lib/explorerOperations", () => ({ downloadBlob: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));
const rawRender = render;
function renderFrame(ui: React.ReactNode) {
  return rawRender(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.listDensity;
  localStorage.clear();
  viewer.id = "artifact-viewer-a";
});

it("offers one portable download with kit, appearance and saved state", async () => {
  document.documentElement.dataset.listDensity = "comfortable";
  const html = '<main data-triune-kit="1"><button>Local tool</button></main>';
  renderFrame(<ArtifactFrame html={html} identity="export-chat:file" title="Exported tool" />);
  const frame = (await screen.findByTitle("Exported tool")) as HTMLIFrameElement;
  const channel = JSON.parse(frame.srcdoc.match(/const channel = (".*?");/)![1]);
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "triune-artifact:state", channel, value: { portable: "saved-value" } },
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download artifact" }));
  const [blob, filename] = vi.mocked(downloadBlob).mock.calls.at(-1)!;
  expect(filename).toBe("Exported tool.html");
  const complete = await blob.text();
  expect(complete).toContain("frame-src about:");
  expect(complete).toContain("Local tool");
  expect(complete).toContain("data-triune-kit-embedded");
  expect(complete).toContain("saved-value");
  expect(complete).toContain("comfortable");
  expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
    "Source",
    "Download artifact",
    "More",
  ]);
});

it("binds state and size messages to the actual frame/channel and restores state only for its viewer and identity", async () => {
  const html = '<main class="ta-root"><input aria-label="Draft"></main>';
  const first = renderFrame(
    <ArtifactFrame html={html} identity="source-chat:file-one" title="Stateful" />,
  );
  const frame = (await screen.findByTitle("Stateful")) as HTMLIFrameElement;
  const channel = JSON.parse(frame.srcdoc.match(/const channel = (".*?");/)![1]);
  function message(source: Window | null, data: unknown) {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source, data }));
    });
  }
  message(window, { type: "triune-artifact:resize", channel, height: 800 });
  message(frame.contentWindow, {
    type: "triune-artifact:resize",
    channel: "another-frame",
    height: 800,
  });
  message(frame.contentWindow, { type: "triune-artifact:resize", channel, height: 50000 });
  expect(frame.style.height).toBe("360px");
  message(frame.contentWindow, { type: "triune-artifact:resize", channel, height: 800 });
  expect(frame.style.height).toBe("800px");
  message(frame.contentWindow, { type: "triune-artifact:resize", channel, height: 80 });
  expect(frame.style.height).toBe("80px");
  message(frame.contentWindow, {
    type: "triune-artifact:state",
    channel,
    value: { counter: "private-counter-seven" },
  });
  await waitFor(() =>
    expect(
      Object.keys(localStorage).some((key) => key.startsWith("omnigent:artifact-state:1:")),
    ).toBe(true),
  );
  const documentBefore = frame.srcdoc;
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(screen.getByTitle("Stateful")).toBe(frame);
  expect(frame.srcdoc).toBe(documentBefore);
  first.unmount();
  const second = renderFrame(
    <ArtifactFrame html={html} identity="source-chat:file-one" title="Restored" />,
  );
  const restored = (await screen.findByTitle("Restored")) as HTMLIFrameElement;
  expect(restored.srcdoc).toContain("private-counter-seven");
  second.unmount();
  viewer.id = "artifact-viewer-b";
  renderFrame(<ArtifactFrame html={html} identity="source-chat:file-one" title="Other viewer" />);
  const other = (await screen.findByTitle("Other viewer")) as HTMLIFrameElement;
  expect(other.srcdoc).not.toContain("private-counter-seven");
});

it("shows escaped HTML through the shared highlighter and copies complete source with remembered wrapping", async () => {
  const html =
    '<!doctype html>\n<script>window.sourceMustNotRun=true</script>\n<p title="&amp;">&lt;literal&gt;</p>';
  renderFrame(<ArtifactFrame html={html} identity="source:test" title="Source test" />);
  await screen.findByTitle("Source test");
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(document.querySelector("script")).toBeNull();
  await waitFor(() =>
    expect(document.querySelector("[data-code-highlighted]")).toHaveAttribute(
      "data-code-highlighted",
      "true",
    ),
  );
  expect(document.querySelector("pre code")?.textContent).toContain("window.sourceMustNotRun=true");
  await userEvent.setup().click(screen.getByRole("button", { name: "Copy source" }));
  expect(copyText).toHaveBeenCalledWith(html);
  const wrap = screen.getByRole("button", { name: "Toggle word wrap" });
  expect(wrap).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(wrap);
  expect(wrap).toHaveAttribute("aria-pressed", "false");
  expect(localStorage.getItem("omnigent:wrap:chat")).toBe("false");
});

it("routes Open in tab through its consumer and uses the same opaque sandbox in a separate window", async () => {
  const onOpenTab = vi.fn();
  const document = window.document.implementation.createHTMLDocument("");
  const popup = { document, opener: window };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  renderFrame(
    <ArtifactFrame
      html='<main class="ta-root">Local</main>'
      identity="open:test"
      title="Open test"
      onOpenTab={onOpenTab}
    />,
  );
  await screen.findByTitle("Open test");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "More" }));
  await user.click(screen.getByRole("menuitem", { name: "Open in tab" }));
  expect(onOpenTab).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "More" }));
  await user.click(screen.getByRole("menuitem", { name: "Open in new window" }));
  expect(open).toHaveBeenCalledWith("about:blank", "_blank", expect.stringContaining("popup"));
  expect(popup.opener).toBeNull();
  const frame = document.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(frame.srcdoc).toContain("data-triune-kit-embedded");
  open.mockRestore();
});

it("caps inline documents to their dock view and expands through the existing route while retaining the iframe", async () => {
  const onOpenTab = vi.fn();
  const geometry = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ top: 0, bottom: 400 } as DOMRect);
  try {
    renderFrame(
      <div data-workbench-view="chat">
        <ArtifactFrame
          inline
          html="<main>Retained</main>"
          identity="inline:test"
          title="Inline"
          onOpenTab={onOpenTab}
        />
      </div>,
    );
    const frame = (await screen.findByTitle("Inline")) as HTMLIFrameElement;
    const document = frame.srcdoc;
    const container = frame.closest<HTMLElement>("[data-triune-artifact]")!;
    expect(container.style.maxHeight).toContain("240px");
    const scroller = screen.getByRole("region", { name: "Inline preview" });
    const channel = JSON.parse(frame.srcdoc.match(/const channel = (".*?");/)![1]);
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "triune-artifact:resize", channel, height: 4096 },
        }),
      ),
    );
    expect(parseFloat(frame.style.height)).toBeLessThanOrEqual(240);
    expect(scroller).toHaveClass("overflow-hidden");
    fireEvent.click(screen.getByRole("button", { name: "Expand artifact" }));
    expect(onOpenTab).toHaveBeenCalledOnce();
    expect(screen.getByTitle("Inline")).toBe(frame);
    expect(frame.srcdoc).toBe(document);
  } finally {
    geometry.mockRestore();
  }
});
