// Modified for Triune.
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import * as chatStore from "@/store/chatStore";
import { conversationRegistry } from "@/store/conversationRegistry";
import * as sessionsApi from "@/lib/sessionsApi";
import type { Session } from "@/lib/types";
import {
  createScopedChatStore,
  ScopedChatStoreProvider,
  useConversationChatStore,
  useConversationChatFocused,
} from "./ScopedChatStore";

const originalActions = useChatStore.getState();
const metadata = vi.hoisted(() => ({ loading: false }));

beforeEach(() => {
  metadata.loading = false;
  conversationRegistry.clear();
  useChatStore.setState({ ...originalActions, conversationId: "primary" });
});

afterEach(() => {
  cleanup();
  conversationRegistry.clear();
  vi.restoreAllMocks();
});

describe("scoped chat store", () => {
  it("keeps a root-opened binding when initial metadata becomes ready", async () => {
    metadata.loading = true;
    const entry = conversationRegistry.acquire("initial");
    const ensure = vi
      .spyOn(chatStore, "ensureConversationStreamed")
      .mockImplementation(async () => {
        if (!entry.getState().abortController)
          entry.setState({ abortController: new AbortController() });
      });
    const view = render(
      <ScopedChatStoreProvider conversationId="initial" visible focused>
        <span>Initial reader</span>
      </ScopedChatStoreProvider>,
    );
    await act(async () => {});
    expect(ensure).not.toHaveBeenCalled();
    const controller = new AbortController();
    const draft = { conversationId: "initial", text: "Keep draft", files: [] };
    // The standalone root switch opens the session before shared metadata settles.
    act(() =>
      entry.setState({
        abortController: controller,
        failedSendDraft: draft,
        oldestItemId: "anchor",
      }),
    );
    metadata.loading = false;
    view.rerender(
      <ScopedChatStoreProvider conversationId="initial" visible focused>
        <span>Initial reader</span>
      </ScopedChatStoreProvider>,
    );
    await act(async () => {});
    expect(controller.signal.aborted).toBe(false);
    expect(entry.getState().abortController).toBe(controller);
    expect(ensure).toHaveBeenCalledOnce();
    expect(entry.getState()).toMatchObject({ failedSendDraft: draft, oldestItemId: "anchor" });
    view.unmount();
    await act(async () => {});
    expect(controller.signal.aborted).toBe(true);
  });
  it("changes focused send ownership without rebinding continuously visible panes", async () => {
    const aborted = vi.fn();
    const ensure = vi
      .spyOn(chatStore, "ensureConversationStreamed")
      .mockImplementation(async (id) => {
        const entry = conversationRegistry.acquire(id);
        if (!entry.getState().abortController) {
          const controller = new AbortController();
          controller.signal.addEventListener("abort", aborted, { once: true });
          entry.setState({ abortController: controller });
        }
      });
    const send = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({ send });
    function Sender({ id }: { id: string }) {
      const store = useConversationChatStore();
      const focused = useConversationChatFocused();
      return (
        <button
          type="button"
          disabled={!focused}
          onClick={() => void store.getState().send("hello", "agent")}
        >
          Send {id}
        </button>
      );
    }
    function Panes({ firstFocused }: { firstFocused: boolean }) {
      return (
        <>
          <ScopedChatStoreProvider conversationId="first" visible focused={firstFocused}>
            <Sender id="first" />
          </ScopedChatStoreProvider>
          <ScopedChatStoreProvider conversationId="second" visible focused={!firstFocused}>
            <Sender id="second" />
          </ScopedChatStoreProvider>
        </>
      );
    }
    const view = render(<Panes firstFocused />);
    await act(async () => {});
    const controllers = ["first", "second"].map(
      (id) => conversationRegistry.peek(id)!.getState().abortController,
    );
    for (let index = 0; index < 10; index++) {
      const firstFocused = index % 2 !== 0;
      view.rerender(<Panes firstFocused={firstFocused} />);
      // eslint-disable-next-line no-await-in-loop -- Each focus transition commits before its send.
      await act(async () => {});
      const target = firstFocused ? "first" : "second";
      fireEvent.click(screen.getByRole("button", { name: `Send ${target}` }));
      expect(send).toHaveBeenLastCalledWith("hello", "agent", undefined, {
        pinnedConversationId: target,
      });
      expect(conversationRegistry.isFocused("first")).toBe(firstFocused);
      expect(conversationRegistry.isFocused("second")).toBe(!firstFocused);
    }
    expect(aborted).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(
      ["first", "second"].map((id) => conversationRegistry.peek(id)!.getState().abortController),
    ).toEqual(controllers);
    view.unmount();
    await act(async () => {});
    expect(aborted).toHaveBeenCalledTimes(2);
  });

  it("keeps another visible owner's stream and recovers the retained reader on reveal", async () => {
    const entry = conversationRegistry.acquire("shared");
    const draft = { conversationId: "shared", text: "unsent", files: [] };
    entry.setState({ failedSendDraft: draft, oldestItemId: "reader-anchor" });
    const ensure = vi
      .spyOn(chatStore, "ensureConversationStreamed")
      .mockImplementation(async () => {
        if (!entry.getState().abortController)
          entry.setState({ abortController: new AbortController() });
      });
    function Owners({ visible, second }: { visible: boolean; second: boolean }) {
      return (
        <>
          <ScopedChatStoreProvider conversationId="shared" visible={visible} focused={visible}>
            <span>Reader</span>
          </ScopedChatStoreProvider>
          {second && (
            <ScopedChatStoreProvider conversationId="shared" visible focused={false}>
              <span>Second owner</span>
            </ScopedChatStoreProvider>
          )}
        </>
      );
    }
    const view = render(<Owners visible second />);
    await act(async () => {});
    const original = entry.getState().abortController!;
    view.rerender(<Owners visible={false} second />);
    await act(async () => {});
    expect(original.signal.aborted).toBe(false);
    view.rerender(<Owners visible={false} second={false} />);
    await act(async () => {});
    expect(original.signal.aborted).toBe(true);
    view.rerender(<Owners visible second={false} />);
    await act(async () => {});
    const resumed = entry.getState().abortController!;
    expect(resumed).not.toBe(original);
    expect(resumed.signal.aborted).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(entry.getState()).toMatchObject({
      failedSendDraft: draft,
      oldestItemId: "reader-anchor",
    });
    view.unmount();
    await act(async () => {});
    expect(resumed.signal.aborted).toBe(true);
  });

  it("leaves route-driven observation establishment to the provider after visibility cleanup", async () => {
    const entry = conversationRegistry.acquire("reader");
    const draft = { conversationId: "reader", text: "Retained draft", files: [] };
    entry.setState({ failedSendDraft: draft, oldestItemId: "older-anchor" });
    const opened: AbortController[] = [];
    const ensure = vi
      .spyOn(chatStore, "ensureConversationStreamed")
      .mockImplementation(async () => {
        if (entry.getState().abortController) return;
        const controller = new AbortController();
        opened.push(controller);
        entry.setState({ abortController: controller });
      });
    function RouteEffect({ pathname }: { pathname: string }) {
      const store = useConversationChatStore();
      useEffect(() => {
        void store.getState().switchTo("reader");
      }, [pathname, store]);
      return null;
    }
    function Reader({ visible, pathname }: { visible: boolean; pathname: string }) {
      return (
        <ScopedChatStoreProvider conversationId="reader" visible={visible} focused={visible}>
          <RouteEffect pathname={pathname} />
        </ScopedChatStoreProvider>
      );
    }
    const view = render(<Reader visible pathname="/a" />);
    await act(async () => {});
    expect(opened).toHaveLength(1);
    view.rerender(<Reader visible={false} pathname="/b" />);
    await act(async () => {});
    expect(opened[0]!.signal.aborted).toBe(true);
    ensure.mockClear();
    const beforeReveal = opened.length;
    // The hidden child's URL effect runs before its provider is revealed.
    view.rerender(<Reader visible={false} pathname="/a" />);
    await act(async () => {});
    expect(ensure).not.toHaveBeenCalled();
    view.rerender(<Reader visible pathname="/a" />);
    await act(async () => {});
    expect(opened).toHaveLength(beforeReveal + 1);
    expect(opened.at(-1)!.signal.aborted).toBe(false);
    expect(entry.getState()).toMatchObject({
      failedSendDraft: draft,
      oldestItemId: "older-anchor",
    });
    view.unmount();
    await act(async () => {});
    expect(opened.at(-1)!.signal.aborted).toBe(true);
  });

  it("detaches when a remembered layout hides while preserving its scoped state", async () => {
    const entry = conversationRegistry.acquire("remembered");
    const controller = new AbortController();
    const draft = { conversationId: "remembered", text: "still typing", files: [] };
    entry.setState({ abortController: controller, failedSendDraft: draft, oldestItemId: "reader" });
    const view = render(
      <ScopedChatStoreProvider conversationId="remembered" focused visible>
        <span>remembered editor</span>
      </ScopedChatStoreProvider>,
    );
    await act(async () => {});
    view.rerender(
      <ScopedChatStoreProvider conversationId="remembered" focused={false} visible={false}>
        <span>remembered editor</span>
      </ScopedChatStoreProvider>,
    );
    await act(async () => {});
    expect(controller.signal.aborted).toBe(true);
    expect(conversationRegistry.peek("remembered")).toBe(entry);
    expect(createScopedChatStore("remembered").getState()).toMatchObject({
      failedSendDraft: draft,
      oldestItemId: "reader",
    });
    expect(screen.getByText("remembered editor")).toBeInTheDocument();
  });

  it("moves a visible chat between pane instances without replacing its subscription", async () => {
    const ensure = vi
      .spyOn(chatStore, "ensureConversationStreamed")
      .mockImplementation(async (id) => {
        conversationRegistry.acquire(id).setState({ abortController: new AbortController() });
      });
    const pane = (key: string) => (
      <ScopedChatStoreProvider key={key} conversationId="shared" visible focused>
        <span>{key}</span>
      </ScopedChatStoreProvider>
    );
    const view = render(pane("left"));
    await act(async () => {});
    const controller = conversationRegistry.peek("shared")!.getState().abortController!;
    view.rerender(pane("right"));
    await act(async () => {});
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(false);
    view.unmount();
    await act(async () => {});
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not notify other scopes for primary fields but still shares globals and queues", () => {
    const first = conversationRegistry.acquire("first");
    conversationRegistry.acquire("second");
    const stores = [createScopedChatStore("first"), createScopedChatStore("second")];
    const snapshots = stores.map((store) => store.getState());
    const listeners = stores.map(() => vi.fn());
    const unsubscribe = stores.map((store, index) => store.subscribe(listeners[index]!));
    try {
      useChatStore.setState({ conversationId: "third", blocks: [], sessionStatus: "running" });
      stores.forEach((store, index) => {
        expect(store.getState()).toBe(snapshots[index]);
        expect(listeners[index]).not.toHaveBeenCalled();
      });

      first.setState({ sessionStatus: "waiting" });
      expect(listeners[0]).toHaveBeenCalledOnce();
      expect(listeners[1]).not.toHaveBeenCalled();

      stores[0]!.setState({ streamBudgetExceeded: true });
      useChatStore.getState().enqueueMessage("later", undefined, undefined, "second");
      stores.forEach((store, index) => {
        expect(store.getState().streamBudgetExceeded).toBe(true);
        expect(store.getState().queuedMessages).toBe(useChatStore.getState().queuedMessages);
        expect(store.getState().queuedMessages.at(-1)).toMatchObject({ conversationId: "second" });
        expect(listeners[index]).toHaveBeenCalledTimes(index === 0 ? 3 : 2);
      });
    } finally {
      unsubscribe.forEach((stop) => stop());
    }
  });

  it("rerenders only consumers whose selected conversation field changes", () => {
    const first = conversationRegistry.acquire("first");
    const second = conversationRegistry.acquire("second");
    const renders = { first: vi.fn(), second: vi.fn() };
    function Status({ id }: { id: "first" | "second" }) {
      const useStore = useConversationChatStore();
      const status = useStore((state) => state.sessionStatus);
      renders[id]();
      return <div data-testid={id}>{status}</div>;
    }
    render(
      <>
        <ScopedChatStoreProvider conversationId="first" focused>
          <Status id="first" />
        </ScopedChatStoreProvider>
        <ScopedChatStoreProvider conversationId="second" focused={false}>
          <Status id="second" />
        </ScopedChatStoreProvider>
      </>,
    );
    act(() => first.setState({ blocks: [] }));
    act(() => second.setState({ sessionStatus: "running" }));
    act(() => useChatStore.setState({ conversationId: "third", sessionStatus: "waiting" }));
    expect(renders.first).toHaveBeenCalledOnce();
    expect(renders.second).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("first")).toHaveTextContent("idle");
    expect(screen.getByTestId("second")).toHaveTextContent("running");
  });

  it("settles a model change on its original conversation after primary focus changes", async () => {
    let finish!: (session: Session) => void;
    const update = vi.spyOn(sessionsApi, "updateSession").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = conversationRegistry.acquire("first");
    const store = createScopedChatStore("first");
    const change = store.getState().setModel("new-model");
    expect(first.getState().sessionModelOverride).toBe("new-model");
    useChatStore.setState({ conversationId: "second", sessionModelOverride: "second-model" });
    finish({ id: "first", modelOverride: "canonical-model" } as Session);
    await change;
    expect(update).toHaveBeenCalledWith("first", { modelOverride: "new-model" });
    expect(first.getState().sessionModelOverride).toBe("canonical-model");
    expect(useChatStore.getState().sessionModelOverride).toBe("second-model");
  });

  it("keeps attachments and navigation flashes local to each mounted composer", () => {
    conversationRegistry.acquire("first");
    conversationRegistry.acquire("second");
    const first = createScopedChatStore("first");
    const second = createScopedChatStore("second");
    first.getState().addComposerAttachment({ path: "first.txt", isDir: false });
    first.getState().flashUserMessage("first-message");
    expect(first.getState().pendingComposerAttachments).toHaveLength(1);
    expect(second.getState().pendingComposerAttachments).toEqual([]);
    expect(second.getState().flashItemId).toBeNull();
    expect(useChatStore.getState().pendingComposerAttachments).toEqual([]);
    first.getState().clearPendingComposerAttachments();
    expect(first.getState().pendingComposerAttachments).toEqual([]);
  });

  it("projects two live entries without switching the primary store", () => {
    const first = conversationRegistry.acquire("first");
    const second = conversationRegistry.acquire("second");
    first.setState({ sessionModelOverride: "model-one" });
    second.setState({ sessionModelOverride: "model-two" });
    function Model() {
      const useStore = useConversationChatStore();
      const id = useStore((s) => s.conversationId);
      const model = useStore((s) => s.sessionModelOverride);
      return <div data-testid={id!}>{model}</div>;
    }
    render(
      <>
        <ScopedChatStoreProvider conversationId="first" focused>
          <Model />
        </ScopedChatStoreProvider>
        <ScopedChatStoreProvider conversationId="second" focused={false}>
          <Model />
        </ScopedChatStoreProvider>
      </>,
    );
    expect(screen.getByTestId("first")).toHaveTextContent("model-one");
    expect(screen.getByTestId("second")).toHaveTextContent("model-two");
    act(() => second.setState({ sessionModelOverride: "model-three" }));
    expect(screen.getByTestId("first")).toHaveTextContent("model-one");
    expect(screen.getByTestId("second")).toHaveTextContent("model-three");
    expect(useChatStore.getState().conversationId).toBe("primary");
  });

  it("pins sends, skills, queues, approvals and history to the originating pane", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const sendSlashCommand = vi.fn().mockResolvedValue(undefined);
    const enqueueMessage = vi.fn();
    const submitApproval = vi.fn().mockResolvedValue(undefined);
    const loadMoreHistory = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      send,
      sendSlashCommand,
      enqueueMessage,
      submitApproval,
      loadMoreHistory,
    });
    const first = createScopedChatStore("first");
    const { send: sendFirst, sendSlashCommand: skillFirst } = first.getState();
    useChatStore.setState({ conversationId: "second" });
    await sendFirst("first prompt", "agent", [], { pinnedConversationId: "wrong" });
    await skillFirst("review", "this", "agent");
    first.getState().enqueueMessage("later");
    await first.getState().submitApproval("approval", "accept");
    await first.getState().loadMoreHistory();
    expect(send).toHaveBeenCalledWith("first prompt", "agent", [], {
      pinnedConversationId: "first",
    });
    expect(sendSlashCommand).toHaveBeenCalledWith("review", "this", "agent", {
      pinnedConversationId: "first",
    });
    expect(enqueueMessage).toHaveBeenCalledWith("later", undefined, undefined, "first");
    expect(submitApproval).toHaveBeenCalledWith(
      "approval",
      "accept",
      undefined,
      undefined,
      "first",
    );
    expect(loadMoreHistory).toHaveBeenCalledWith("first");
    expect(useChatStore.getState().conversationId).toBe("second");
  });

  it("routes updates to the entry and preserves global queue state", () => {
    const entry = conversationRegistry.acquire("first");
    const store = createScopedChatStore("first");
    expect(store.getState()).toBe(store.getState());
    store.setState({ sessionReasoningEffort: "high" });
    expect(entry.getState().sessionReasoningEffort).toBe("high");
    expect(useChatStore.getState().sessionReasoningEffort).toBeNull();
    expect(() => store.setState({ conversationId: "second" })).toThrow("cannot change");
    expect(store.getState().conversationId).toBe("first");
  });
});

// These scenarios start after viewer discovery; startup ordering uses the real hook in chatStore.test.ts.
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ isLoading: metadata.loading }) }));
