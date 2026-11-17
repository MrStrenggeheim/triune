// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LazyPullRequestPanel } from "./LazyPullRequestPanel";

vi.mock("./PullRequestPanel", () => ({
  get PullRequestPanel() {
    throw new TypeError("Failed to fetch dynamically imported module: /assets/old-pr.js");
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("contains a failed first import without reloading or replacing other unsaved panes", async () => {
  const reload = vi.fn();
  vi.stubGlobal("location", { reload });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const send = vi.fn();
  const content = (
    <>
      <textarea aria-label="Other editor" defaultValue="unsaved buffer" />
      <input aria-label="Other composer" defaultValue="unsent draft" />
      <button type="button" onClick={send}>
        Send from other pane
      </button>
      <LazyPullRequestPanel conversationId="captured-chat" viewId="pr-view" />
    </>
  );
  render(content);
  const editor = screen.getByLabelText("Other editor");
  const composer = screen.getByLabelText("Other composer");
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load this page");
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Other editor")).toBe(editor);
  expect(editor).toHaveValue("unsaved buffer");
  expect(screen.getByLabelText("Other composer")).toBe(composer);
  expect(composer).toHaveValue("unsent draft");
  fireEvent.click(screen.getByRole("button", { name: "Send from other pane" }));
  expect(send).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Refresh page" }));
  expect(reload).toHaveBeenCalledOnce();
});
