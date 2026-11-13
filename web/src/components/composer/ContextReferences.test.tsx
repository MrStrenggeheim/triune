import { createRef } from "react";
import { useMentionBrowser } from "@/hooks/useMentionBrowser";
import { readReferenceDraft, writeReferenceDraft } from "@/lib/contextReferenceDrafts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerMentionMenu } from "./ComposerMentionMenu";
import { ComposerMentionChips } from "./ComposerMentionChips";
import { QuoteDestinationMenu } from "@/components/chat/QuoteDestinationMenu";
import { ContextReferenceNavigationContext } from "@/lib/contextReferenceNavigation";
import * as api from "@/lib/contextReferences";
import { getSessionDraft, setSessionDraft, clearSessionDrafts } from "@/lib/sessionDrafts";
import { registerQuoteDestination } from "@/lib/quoteDraftDestinations";
import { useChatStore } from "@/store/chatStore";
import { buildMentionPreamble } from "@/lib/composerMentions";

vi.mock("@/lib/contextReferences", async (original) => ({
  ...(await original<typeof api>()),
  captureReference: vi.fn(),
  searchReferenceChats: vi.fn(),
  referenceRequest: vi.fn(),
}));
const navigation = { openConversation: vi.fn(), createSubchat: vi.fn() };
const reference: api.ContextReference = {
  version: 1,
  snapshot_id: "frozen",
  source_id: "source",
  source_title: "Source chat",
  destination_id: "target",
  scope: "whole",
  boundary_id: "item-at-selection",
  captured_at: 100,
  items: [
    {
      id: "item-at-selection",
      response_id: "response",
      created_at: 99,
      created_by: "author",
      role: "user",
      content: [{ type: "input_text", text: "Exact **source**" }],
    },
  ],
  quote: "Selected text",
  audience: "Visible to everyone with access to the destination",
  representation: "Exact stored items as JSON",
};
const source: api.QuoteSource = {
  conversationId: "source",
  boundaryId: "response",
  text: "Selected text",
};
beforeEach(() => {
  clearSessionDrafts();
  useChatStore.setState({ sideChatComposers: {}, sideChatDrafts: {} });
  vi.mocked(api.searchReferenceChats).mockResolvedValue({
    data: [{ id: "target", title: "Destination", parent_id: null }],
    has_more: false,
    next_cursor: null,
  });
  vi.mocked(api.captureReference).mockResolvedValue(reference);
  vi.mocked(api.referenceRequest).mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([
  ["Whole chat", "whole"],
  ["Last completed answer", "last_answer"],
] as const)("previews exact %s content and audience before adding", async (label, scope) => {
  const attach = vi.fn();
  render(
    <ComposerMentionMenu
      query="source"
      destinationId="target"
      onReference={attach}
      currentDir=""
      activeIndex={-1}
      entries={[]}
      onAttach={vi.fn()}
      onOpenDir={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
  fireEvent.click(await screen.findByRole("button", { name: "Destination" }));
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(await screen.findByText(reference.audience)).toBeVisible();
  expect(api.captureReference).toHaveBeenCalledWith("target", "target", scope, { message_ids: [] });
  expect(screen.getByText(/Exact \*\*source\*\*/)).toBeVisible();
  expect(attach).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add reference" }));
  expect(attach).toHaveBeenCalledWith(reference);
});

it("retains reference scope on the chip and serializes exact frozen source", () => {
  const item = { path: "Source chat", isDir: false, reference };
  render(<ComposerMentionChips items={[item]} onRemove={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "@Source chat · Whole chat" }));
  expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
    "href",
    "/c/source?message=item-at-selection",
  );
  expect(buildMentionPreamble([item], "codex-native")).toContain(JSON.stringify(reference));
});

it("inserts an existing destination draft without sending or dropping attachments", async () => {
  const file = new File(["file"], "keep.txt");
  setSessionDraft("target", { text: "Existing draft", files: [file] });
  const open = navigation.openConversation,
    create = navigation.createSubchat,
    close = vi.fn();
  const send = vi.spyOn(useChatStore.getState(), "send");
  render(
    <ContextReferenceNavigationContext.Provider value={navigation}>
      <QuoteDestinationMenu source={source} x={0} y={0} onClose={close} />
    </ContextReferenceNavigationContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Destination" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(getSessionDraft("target")?.text).toContain("Existing draft");
  expect(getSessionDraft("target")?.replyDraft?.quotes[0]?.text).toBe(reference.quote);
  expect(readReferenceDraft("target")).toEqual([reference]);
  expect(getSessionDraft("target")?.files).toEqual([file]);
  expect(useChatStore.getState().sideChatComposers.target.files).toEqual([file]);
  expect(open).toHaveBeenCalledWith("target", { beside: true, title: "Destination" });
  expect(create).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  send.mockRestore();
});

it("creates a subchat at the captured item even if the source advances while choosing", async () => {
  const create = navigation.createSubchat.mockResolvedValue("child");
  render(
    <ContextReferenceNavigationContext.Provider value={navigation}>
      <QuoteDestinationMenu source={source} x={0} y={0} onClose={vi.fn()} />
    </ContextReferenceNavigationContext.Provider>,
  );
  await waitFor(() => expect(api.captureReference).toHaveBeenCalledTimes(1));
  await act(async () => {});
  vi.mocked(api.captureReference).mockResolvedValue({ ...reference, boundary_id: "later-item" });
  fireEvent.click(screen.getByRole("button", { name: "New subchat" }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      { ...source, boundaryId: "item-at-selection" },
      expect.any(Function),
    ),
  );
  await waitFor(() =>
    expect(navigation.openConversation).toHaveBeenCalledWith("child", {
      beside: true,
      title: "Subchat",
    }),
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(api.captureReference).toHaveBeenCalledTimes(1);
  expect(useChatStore.getState().sideChatDrafts.child).toBeUndefined();
  expect(readReferenceDraft("child")[0]?.boundary_id).toBe("item-at-selection");
});

it("uses a mounted destination's current draft and keeps revoked sources out", async () => {
  const insert = vi.fn();
  const unregister = registerQuoteDestination("target", insert);
  vi.mocked(api.referenceRequest).mockRejectedValue(new Error("Source access revoked"));
  render(
    <ContextReferenceNavigationContext.Provider value={navigation}>
      <QuoteDestinationMenu source={source} x={0} y={0} onClose={vi.fn()} />
    </ContextReferenceNavigationContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Destination" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Source access revoked");
  expect(insert).not.toHaveBeenCalled();
  vi.mocked(api.referenceRequest).mockResolvedValue({ ok: true });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
  unregister();
});

it("chooses explicit messages and never substitutes a summary for an oversized whole chat", async () => {
  vi.mocked(api.referenceRequest).mockResolvedValue({
    data: [{ ...reference.items[0], type: "message" }],
    has_more: false,
  });
  vi.mocked(api.captureReference).mockRejectedValueOnce(
    new Error("Context is too large. Choose messages; nothing was summarized."),
  );
  const attach = vi.fn();
  render(
    <ComposerMentionMenu
      query="source"
      destinationId="target"
      onReference={attach}
      currentDir=""
      activeIndex={-1}
      entries={[]}
      onAttach={vi.fn()}
      onOpenDir={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
  fireEvent.click(await screen.findByRole("button", { name: "Destination" }));
  fireEvent.click(screen.getByRole("button", { name: "Whole chat" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("nothing was summarized");
  expect(attach).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Choose messages" }));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
  await screen.findByRole("button", { name: "Add reference" });
  expect(api.captureReference).toHaveBeenLastCalledWith("target", "target", "messages", {
    message_ids: ["item-at-selection"],
  });
});

it("hydrates inserted snapshot chips into an open composer and restores them after remount", () => {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const mount = () =>
    renderHook(() =>
      useMentionBrowser({
        referenceDraftKey: "target",
        mention: null,
        setMention: vi.fn(),
        mentionEntries: [],
        text: "draft",
        setText: vi.fn(),
        textareaRef,
      }),
    );
  const first = mount();
  act(() => first.result.current.setMentionedItems([{ path: "keep.txt", isDir: false }]));
  act(() => writeReferenceDraft("target", [reference]));
  expect(first.result.current.mentionedItems).toEqual([
    { path: "keep.txt", isDir: false },
    { path: reference.source_title, isDir: false, reference },
  ]);
  first.unmount();
  const restored = mount();
  expect(restored.result.current.mentionedItems[0].reference).toEqual(reference);
  act(() => clearSessionDrafts());
  expect(restored.result.current.mentionedItems).toEqual([]);
});
