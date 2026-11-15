// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactFrame } from "./ArtifactFrame";
import { downloadBlob } from "@/lib/explorerOperations";

const viewer = vi.hoisted(() => ({ id: "artifact-viewer-a" }));
vi.mock("@/hooks/useViewerId", () => ({ useViewerId: () => viewer.id }));
vi.mock("@/lib/explorerOperations", () => ({ downloadBlob: vi.fn() }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  viewer.id = "artifact-viewer-a";
});

it("exports a complete isolated HTML file while leaving original download ownership with its caller", async () => {
  const original = vi.fn();
  const html = '<main data-triune-kit="1"><button>Local tool</button></main>';
  render(
    <ArtifactFrame
      html={html}
      identity="export-chat:file"
      title="Exported tool"
      onDownload={original}
    />,
  );
  await screen.findByTitle("Exported tool");
  fireEvent.click(screen.getByRole("button", { name: "Download self-contained HTML" }));
  const [blob, filename] = vi.mocked(downloadBlob).mock.calls.at(-1)!;
  expect(filename).toBe("Exported tool.html");
  const complete = await blob.text();
  expect(complete).toContain("frame-src about:");
  expect(complete).toContain("Local tool");
  expect(complete).toContain("data-triune-kit-embedded");
  expect(original).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Download Exported tool" }));
  expect(original).toHaveBeenCalledOnce();
});

it("binds state and size messages to the actual frame/channel and restores state only for its viewer and identity", async () => {
  const html = '<main class="ta-root"><input aria-label="Draft"></main>';
  const first = render(
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
  fireEvent.click(screen.getByRole("button", { name: "Show artifact source" }));
  fireEvent.click(screen.getByRole("button", { name: "Show artifact preview" }));
  expect(screen.getByTitle("Stateful")).toBe(frame);
  expect(frame.srcdoc).toBe(documentBefore);
  first.unmount();
  const second = render(
    <ArtifactFrame html={html} identity="source-chat:file-one" title="Restored" />,
  );
  const restored = (await screen.findByTitle("Restored")) as HTMLIFrameElement;
  expect(restored.srcdoc).toContain("private-counter-seven");
  second.unmount();
  viewer.id = "artifact-viewer-b";
  render(<ArtifactFrame html={html} identity="source-chat:file-one" title="Other viewer" />);
  const other = (await screen.findByTitle("Other viewer")) as HTMLIFrameElement;
  expect(other.srcdoc).not.toContain("private-counter-seven");
});
