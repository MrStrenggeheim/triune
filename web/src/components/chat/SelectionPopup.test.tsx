// Modified for Triune.

import { createRef } from "react";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { setEmbedRoot } from "@/lib/host";
import { SelectionPopup } from "./SelectionPopup";
import { ConversationScopeContext } from "./conversationScope";
import { ContextReferenceNavigationContext } from "@/lib/contextReferenceNavigation";
import * as references from "@/lib/contextReferences";
import { clearSessionDrafts, getSessionDraft, setSessionDraft } from "@/lib/sessionDrafts";
import { useChatStore } from "@/store/chatStore";
import { toast, type Action } from "@/lib/notifications";

vi.mock("@/lib/notifications", () => ({
  toast: { loading: vi.fn(() => "loading"), dismiss: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/contextReferences", async (original) => ({
  ...(await original<typeof references>()),
  captureReference: vi.fn(),
  searchReferenceChats: vi.fn(),
  referenceRequest: vi.fn(),
}));

afterEach(() => {
  cleanup();
  setEmbedRoot(null);
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  clearSessionDrafts();
  useChatStore.setState({ sideChatComposers: {}, sideChatDrafts: {} });
});

it.each([true, false])("portals outside the transcript (embedded: %s)", (embedded) => {
  const containerRef = createRef<HTMLDivElement>();
  const onReply = vi.fn();
  const { container } = render(
    <>
      <div ref={containerRef}>Selected message</div>
      <SelectionPopup containerRef={containerRef} onReply={onReply} />
    </>,
  );
  if (embedded) setEmbedRoot(container);

  const range = document.createRange();
  range.selectNodeContents(containerRef.current!);
  range.getBoundingClientRect = () => new DOMRect(10, 30, 80, 20);
  range.getClientRects = () => [] as unknown as DOMRectList;
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));

  const reply = screen.getByRole("menuitem", { name: "Reply" });
  expect(reply.querySelectorAll("svg")).toHaveLength(1);
  expect(reply.firstElementChild?.tagName).toBe("svg");
  expect(reply.textContent).toBe("Reply");
  expect(reply.parentElement?.parentElement).toBe(embedded ? container : document.body);
  expect(reply.parentElement).toHaveClass("fixed");
  expect(reply.parentElement).toHaveStyle({ left: "10px", top: "24px" });
  fireEvent.click(reply);
  expect(onReply).toHaveBeenCalledExactlyOnceWith("Selected message");
  expect(screen.queryByRole("menuitem", { name: "Reply" })).toBeNull();
});

function selectMessage(onAskInSideChat?: (text: string) => void) {
  const containerRef = createRef<HTMLDivElement>();
  const onReply = vi.fn();
  render(
    <>
      <div ref={containerRef}>Selected message</div>
      <div data-testid="composer">Composer text</div>
      <SelectionPopup
        containerRef={containerRef}
        onReply={onReply}
        onAskInSideChat={onAskInSideChat}
      />
    </>,
  );
  const range = document.createRange();
  range.selectNodeContents(containerRef.current!);
  range.getBoundingClientRect = () => new DOMRect(10, 200, 500, 80);
  range.getClientRects = () => [new DOMRect(30, 200, 80, 20)] as unknown as DOMRectList;
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  return { onReply, range };
}

it.each(["mouse", "touch"])(
  "preserves the selection during %s activation and asks in side chat once",
  (pointerType) => {
    const onAsk = vi.fn();
    const { onReply } = selectMessage(onAsk);
    const ask = screen.getByRole("menuitem", { name: "Ask subchat…" });
    const menu = screen.getByRole("menu", { name: "Selected text" });
    expect(menu.className).toContain("shadow-menu");
    expect(menu.style.left).toBe("30px");
    expect(menu.style.top).toBe("194px");
    const press = createEvent.pointerDown(ask, { cancelable: true });
    Object.defineProperty(press, "pointerType", { value: pointerType });
    fireEvent(ask, press);
    expect(press.defaultPrevented).toBe(true);
    expect(fireEvent.mouseDown(ask)).toBe(false);
    expect(window.getSelection()?.toString()).toBe("Selected message");
    fireEvent.click(ask);
    expect(onAsk).toHaveBeenCalledExactlyOnceWith("Selected message");
    expect(onReply).not.toHaveBeenCalled();
    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  },
);

it("uses keyboard menu navigation and keeps the selected quote after focus moves", async () => {
  const user = userEvent.setup();
  const onAsk = vi.fn();
  selectMessage(onAsk);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Reply" }));
  await user.keyboard("{ArrowRight}");
  fireEvent(document, new Event("selectionchange"));
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Ask subchat…" }));
  await user.keyboard("{Enter}");
  expect(onAsk).toHaveBeenCalledExactlyOnceWith("Selected message");
});

it("dismisses on Escape or an outside press and hides unsupported side chat", () => {
  const { onReply } = selectMessage();
  expect(screen.queryByRole("menuitem", { name: "Ask subchat…" })).toBeNull();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.mouseUp(document);
  expect(screen.getByRole("menu")).toBeVisible();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(onReply).not.toHaveBeenCalled();
});

it("ignores selections in or extending into the composer", () => {
  const { range } = selectMessage();
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  range.setEnd(screen.getByTestId("composer").firstChild!, 4);
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  expect(screen.queryByRole("menu")).toBeNull();
  selection.removeAllRanges();
  range.selectNodeContents(screen.getByTestId("composer"));
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  expect(screen.queryByRole("menu")).toBeNull();
});

const capturedQuote: references.ContextReference = {
  version: 1,
  snapshot_id: "selected-snapshot",
  source_id: "scoped-child",
  source_title: "Child conversation",
  destination_id: null,
  scope: "quote",
  boundary_id: "selected-item",
  captured_at: 100,
  items: [{ id: "selected-item", response_id: "response", created_at: 99 }],
  quote: "Selected message",
  audience: "Visible to everyone with access to the destination",
  representation: "Exact stored items as JSON",
};

const quoteNavigation = { openConversation: vi.fn(), createSubchat: vi.fn() };

function selectScopedMessage() {
  const containerRef = createRef<HTMLDivElement>();
  quoteNavigation.openConversation.mockClear();
  quoteNavigation.createSubchat.mockReset().mockResolvedValue("child");
  const legacyAsk = vi.fn();
  vi.mocked(references.captureReference).mockResolvedValue(capturedQuote);
  vi.mocked(references.referenceRequest).mockResolvedValue({ ok: true });
  vi.mocked(references.searchReferenceChats).mockResolvedValue({
    data: [{ id: "target", title: "Destination", parent_id: null }],
    has_more: false,
    next_cursor: null,
  });
  useChatStore.setState({ conversationId: "unrelated-root" });
  render(
    <ContextReferenceNavigationContext.Provider value={quoteNavigation}>
      <ConversationScopeContext.Provider value="scoped-child">
        <div ref={containerRef}>
          <p data-message-id="selected-item">Selected message</p>
          <p data-message-id="later-item">Later answer</p>
        </div>
        <SelectionPopup containerRef={containerRef} onReply={vi.fn()} onAskInSideChat={legacyAsk} />
      </ConversationScopeContext.Provider>
    </ContextReferenceNavigationContext.Provider>,
  );
  const range = document.createRange();
  range.selectNodeContents(screen.getByText("Selected message"));
  range.getBoundingClientRect = () => new DOMRect(10, 200, 80, 20);
  range.getClientRects = () => [] as unknown as DOMRectList;
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  return { navigation: quoteNavigation, legacyAsk };
}

it("asks a durable subchat from the scoped selected item with an attributed unsent quote", async () => {
  const { navigation, legacyAsk } = selectScopedMessage();
  const send = vi.spyOn(useChatStore.getState(), "send");
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Reply",
    "Ask subchat…",
    "Send to…",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Ask subchat…" }));
  await waitFor(() =>
    expect(navigation.openConversation).toHaveBeenCalledWith("child", {
      beside: true,
      title: "Subchat",
    }),
  );
  expect(references.captureReference).toHaveBeenCalledExactlyOnceWith(
    "scoped-child",
    null,
    "quote",
    {
      boundary_id: "selected-item",
      message_ids: ["selected-item"],
      quote: "Selected message",
    },
  );
  expect(navigation.createSubchat).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      conversationId: "scoped-child",
      boundaryId: "selected-item",
      text: "Selected message",
    }),
    expect.any(Function),
  );
  expect(references.referenceRequest).not.toHaveBeenCalled();
  expect(getSessionDraft("child")?.text).toBe("> Selected message");
  expect(getSessionDraft("scoped-child")).toBeUndefined();
  expect(legacyAsk).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("retains the selection and source draft after child creation fails and retries explicitly", async () => {
  const { navigation } = selectScopedMessage();
  navigation.createSubchat.mockRejectedValueOnce(new Error("Cannot create child"));
  setSessionDraft("scoped-child", { text: "Keep parent draft", files: [] });
  fireEvent.click(screen.getByRole("menuitem", { name: "Ask subchat…" }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Cannot create child", expect.anything()),
  );
  expect(navigation.createSubchat).toHaveBeenCalledTimes(1);
  expect(navigation.openConversation).not.toHaveBeenCalled();
  expect(getSessionDraft("child")).toBeUndefined();
  expect(getSessionDraft("scoped-child")?.text).toBe("Keep parent draft");
  expect(window.getSelection()?.toString()).toBe("Selected message");
  await act(async () => {
    const action = vi.mocked(toast.error).mock.calls.at(-1)?.[1]?.action as Action | undefined;
    if (!action) throw new Error("Expected a retry action");
    action.onClick({} as React.MouseEvent<HTMLButtonElement>);
  });
  await waitFor(() =>
    expect(navigation.openConversation).toHaveBeenCalledWith("child", {
      beside: true,
      title: "Subchat",
    }),
  );
  expect(navigation.createSubchat).toHaveBeenCalledTimes(2);
  expect(references.captureReference).toHaveBeenCalledTimes(1);
  expect(getSessionDraft("child")?.text.match(/> Selected message/g)).toHaveLength(1);
});

it("inserts from Send to's existing chat picker without confirmation or sending", async () => {
  const { navigation } = selectScopedMessage();
  setSessionDraft("target", { text: "Destination draft", files: [] });
  const send = vi.spyOn(useChatStore.getState(), "send");
  fireEvent.click(screen.getByRole("menuitem", { name: "Send to…" }));
  expect(screen.getByRole("dialog", { name: "Send to" })).toHaveClass(
    "selectionmenu",
    "slim-scrollbar",
  );
  fireEvent.click(await screen.findByRole("button", { name: "Destination" }));
  await waitFor(() =>
    expect(navigation.openConversation).toHaveBeenCalledWith("target", {
      beside: true,
      title: "Destination",
    }),
  );
  expect(getSessionDraft("target")?.text).toContain("Destination draft\n\n> Selected message");
  expect(navigation.createSubchat).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("does not recheck a new fork's destination after authorized creation", async () => {
  const { navigation } = selectScopedMessage();
  vi.mocked(references.referenceRequest).mockRejectedValueOnce(new Error("Source access revoked"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Ask subchat…" }));
  await waitFor(() =>
    expect(navigation.openConversation).toHaveBeenCalledWith("child", {
      beside: true,
      title: "Subchat",
    }),
  );
  expect(navigation.createSubchat).toHaveBeenCalledTimes(1);
  expect(references.referenceRequest).not.toHaveBeenCalled();
  expect(getSessionDraft("child")?.replyDraft?.quotes[0]?.text).toBe("Selected message");
});
