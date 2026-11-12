// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextReferenceNavigationContext } from "@/lib/contextReferenceNavigation";
import * as api from "@/lib/contextReferences";
import { clearSessionDrafts, getSessionDraft, setSessionDraft } from "@/lib/sessionDrafts";
import { setEmbedRoot } from "@/lib/host";
import { QuoteDestinationMenu } from "./QuoteDestinationMenu";

vi.mock("@/lib/contextReferences", async (original) => ({
  ...(await original<typeof api>()),
  captureReference: vi.fn(),
  searchReferenceChats: vi.fn(),
  referenceRequest: vi.fn(),
}));
const source = { conversationId: "source", boundaryId: "item", text: "Exact quote" };
const reference: api.ContextReference = {
  version: 1,
  snapshot_id: "frozen",
  source_id: "source",
  source_title: "Source",
  destination_id: null,
  scope: "quote",
  boundary_id: "item",
  captured_at: 10,
  items: [{ id: "item", response_id: "turn", created_at: 9 }],
  quote: "Exact quote",
  audience: "Visible to everyone with access",
  representation: "Stored items",
};
const navigation = { openConversation: vi.fn(), createSubchat: vi.fn() };
function menu(props: Partial<React.ComponentProps<typeof QuoteDestinationMenu>> = {}) {
  return (
    <ContextReferenceNavigationContext.Provider value={navigation}>
      <QuoteDestinationMenu source={source} x={20} y={40} onClose={vi.fn()} {...props} />
    </ContextReferenceNavigationContext.Provider>
  );
}
beforeEach(() => {
  vi.mocked(api.captureReference).mockResolvedValue(reference);
  vi.mocked(api.searchReferenceChats).mockResolvedValue({
    data: [{ id: "target", title: "Destination", parent_id: null }],
    has_more: false,
    next_cursor: null,
  });
  vi.mocked(api.referenceRequest).mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  setEmbedRoot(null);
  clearSessionDrafts();
  vi.resetAllMocks();
});

it.each([false, true])(
  "dismisses outside and restores keyboard focus on Escape (embedded: %s)",
  async (embedded) => {
    const root = document.createElement("div");
    document.body.append(root);
    if (embedded) setEmbedRoot(root);
    const trigger = document.createElement("button");
    trigger.textContent = "Quote source";
    root.append(trigger);
    trigger.focus();
    const close = vi.fn();
    const first = render(menu({ onClose: close }));
    await screen.findByRole("button", { name: "Destination" });
    expect(
      screen.getByRole("dialog", { name: "Send to" }).closest("[data-radix-popper-content-wrapper]")
        ?.parentElement,
    ).toBe(embedded ? root : document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(close).toHaveBeenCalledTimes(1);
    first.unmount();
    render(
      <>
        <button type="button">Outside</button>
        {menu({ onClose: close })}
      </>,
    );
    await screen.findByRole("button", { name: "Destination" });
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    expect(close).toHaveBeenCalledTimes(2);
    root.remove();
  },
);

it("ignores a captured snapshot that resolves after dismissal", async () => {
  let finish!: (value: api.ContextReference) => void;
  vi.mocked(api.captureReference).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(menu({ intent: "subchat" }));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => finish(reference));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(navigation.createSubchat).not.toHaveBeenCalled();
  expect(navigation.openConversation).not.toHaveBeenCalled();
});

it("retains newer destination drafts when authorization resolves after dismissal", async () => {
  let finish!: (value: { ok: boolean }) => void;
  vi.mocked(api.referenceRequest).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(menu());
  await userEvent.click(await screen.findByRole("button", { name: "Destination" }));
  await userEvent.click(screen.getByRole("button", { name: "Insert quote" }));
  await waitFor(() => expect(api.referenceRequest).toHaveBeenCalled());
  fireEvent.keyDown(document.body, { key: "Escape" });
  setSessionDraft("target", { text: "Newer draft", files: [] });
  await act(async () => finish({ ok: true }));
  expect(getSessionDraft("target")?.text).toBe("Newer draft");
  expect(navigation.openConversation).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not reopen or navigate when a dismissed child launch resolves", async () => {
  let finish!: (id: string) => void;
  navigation.createSubchat.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(menu({ intent: "subchat" }));
  await waitFor(() => expect(navigation.createSubchat).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => finish("child"));
  expect(navigation.openConversation).not.toHaveBeenCalled();
  expect(api.referenceRequest).not.toHaveBeenCalled();
  expect(getSessionDraft("child")).toBeUndefined();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("retries failed quote capture explicitly and creates only one child", async () => {
  vi.mocked(api.captureReference).mockRejectedValueOnce(new Error("Temporary failure"));
  navigation.createSubchat.mockResolvedValue("child");
  render(menu({ intent: "subchat" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Temporary failure");
  await userEvent.click(screen.getByRole("button", { name: "Retry capture" }));
  await waitFor(() =>
    expect(navigation.openConversation).toHaveBeenCalledWith("child", { beside: true }),
  );
  expect(navigation.createSubchat).toHaveBeenCalledTimes(1);
  expect(getSessionDraft("child")?.text).toContain("> Exact quote");
});
