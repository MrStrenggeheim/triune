// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CapturedFileGate } from "./CapturedFileGate";
import type { AttachmentPreviewRequest } from "@/components/ChatAttachment";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), error: vi.fn(), scope: "server-a/user-a" }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("@/lib/notifications", () => ({ toast: { error: mocks.error } }));
vi.mock("@/lib/resourceViewStorage", () => ({ resourceViewStorageScope: () => mocks.scope }));
const request: AttachmentPreviewRequest = {
  sessionId: "source chat",
  itemId: "source item",
  reference: "/workspace/document ü.md",
};
const success = () =>
  Response.json({ filename: "document ü.md", mime: "text/markdown", bytes: 42 });

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.error.mockReset();
  mocks.scope = "server-a/user-a";
});
afterEach(cleanup);

function mount(target = request) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (next: AttachmentPreviewRequest) => (
    <QueryClientProvider client={client}>
      <CapturedFileGate request={next}>
        <textarea aria-label="Live file editor" defaultValue={next.reference} />
      </CapturedFileGate>
    </QueryClientProvider>
  );
  return { ...render(tree(target)), tree };
}

it("shows immediate preparation feedback and mounts the editor only after capture commits", async () => {
  let complete!: (response: Response) => void;
  mocks.fetch.mockReturnValue(
    new Promise<Response>((resolve) => {
      complete = resolve;
    }),
  );
  mount();
  expect(screen.getByRole("status")).toHaveTextContent("Preparing file");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await act(async () => complete(success()));
  expect(await screen.findByRole("textbox")).toHaveValue(request.reference);
  const [url, options] = mocks.fetch.mock.calls[0];
  expect(url).toContain("/sessions/source%20chat/attachments/references/source%20item/capture?");
  expect(new URL(url, "https://example.test").searchParams.get("path")).toBe(request.reference);
  expect(options.method).toBe("POST");
  expect(options.signal).toBeInstanceOf(AbortSignal);
});

it("keeps failed capture behind Retry and reports its error through notifications", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("Host disconnected")).mockResolvedValue(success());
  mount();
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
  fireEvent.click(retry);
  expect(await screen.findByRole("textbox")).toBeInTheDocument();
});

it("does not enable a new source's editor when an older capture finishes", async () => {
  let complete!: (response: Response) => void;
  mocks.fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  const view = mount();
  const oldComplete = complete;
  const next = { ...request, sessionId: "different chat", reference: "/different/file.md" };
  view.rerender(view.tree(next));
  await act(async () => oldComplete(success()));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await act(async () => complete(success()));
  expect(await screen.findByRole("textbox")).toHaveValue(next.reference);
});

it("captures the same reference again after an account or server change", async () => {
  mocks.fetch.mockResolvedValueOnce(success()).mockReturnValue(new Promise(() => {}));
  const view = mount();
  expect(await screen.findByRole("textbox")).toBeInTheDocument();
  mocks.scope = "server-b/user-b";
  view.rerender(view.tree(request));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Preparing file");
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
