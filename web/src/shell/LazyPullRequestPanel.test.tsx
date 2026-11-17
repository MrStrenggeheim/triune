// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { LazyPullRequestPanel } from "./LazyPullRequestPanel";

const loading = vi.hoisted(() => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  return { pending, resolve, imported: vi.fn(), props: vi.fn() };
});

vi.mock("./PullRequestPanel", async () => {
  loading.imported();
  await loading.pending;
  return {
    PullRequestPanel: (props: ComponentProps<typeof LazyPullRequestPanel>) => {
      loading.props(props);
      const [draft, setDraft] = useState("");
      return (
        <div data-testid="pr-content">
          {props.locationControls}
          <textarea
            aria-label="New PR comment"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
      );
    },
  };
});

afterEach(cleanup);

it("waits for first mount, forwards the captured view and retains its loaded state when hidden", async () => {
  const { rerender } = render(<div>Chat only</div>);
  expect(loading.imported).not.toHaveBeenCalled();
  const props = {
    conversationId: "captured-chat",
    viewId: "captured-pr-view",
    active: true,
    hideLocation: true,
    locationControls: <button type="button">Captured folder</button>,
  };

  rerender(<LazyPullRequestPanel {...props} />);
  expect(screen.getByRole("status", { name: "Loading pull requests" })).toBeInTheDocument();
  expect(screen.queryByLabelText("New PR comment")).not.toBeInTheDocument();
  await act(async () => loading.resolve());
  const draft = await screen.findByLabelText("New PR comment");
  const content = screen.getByTestId("pr-content");
  content.scrollTop = 123;
  fireEvent.change(draft, { target: { value: "Keep this unsent comment" } });

  rerender(<LazyPullRequestPanel {...props} active={false} />);
  rerender(<LazyPullRequestPanel {...props} />);

  expect(screen.getByLabelText("New PR comment")).toBe(draft);
  expect(draft).toHaveValue("Keep this unsent comment");
  expect(screen.getByTestId("pr-content")).toBe(content);
  expect(content.scrollTop).toBe(123);
  expect(screen.getByRole("button", { name: "Captured folder" })).toBeInTheDocument();
  expect(loading.props).toHaveBeenCalledWith({ ...props, active: false });
  expect(loading.props).toHaveBeenLastCalledWith(props);
  expect(loading.imported).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status", { name: "Loading pull requests" })).not.toBeInTheDocument();
});
