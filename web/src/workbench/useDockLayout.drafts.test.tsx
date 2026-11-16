// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, renderHook } from "@testing-library/react";
import { startTransition, useState } from "react";
import { flushSync } from "react-dom";
import { describe, expect, it } from "vitest";
import { addDockView, createDockLayout, dockPaneForView, type DockView } from "./dockLayout";
import { useDockLayout } from "./useDockLayout";

const owner = {
  id: "conversation:a",
  kind: "conversation",
  title: "A",
  resource: { conversationId: "a" },
};
const draft: DockView = {
  id: "draft:d",
  kind: "conversation",
  title: "New chat",
  resource: { draftId: "d" },
};
const scope = { accountId: "account", serverId: "server", clientId: "browser" };

describe("pane chat draft promotion", () => {
  it("retains a new global owner through an intervening synchronous render", async () => {
    const paneChat = { ...owner, id: "conversation:pane", resource: { conversationId: "pane" } };
    const globalChat = {
      ...owner,
      id: "conversation:global",
      resource: { conversationId: "global" },
    };
    const layout = addDockView(createDockLayout([owner]), paneChat, { edge: "right" });
    const { result } = renderHook(() => {
      const [, render] = useState(0);
      return {
        ...useDockLayout({ scope, initialLayout: layout, storage: null }),
        render: () => render((value) => value + 1),
      };
    });
    act(() => result.current.saveChatLayout("a"));
    act(() => {
      startTransition(() => {
        void result.current.navigateConversation("global");
      });
      flushSync(() => result.current.render());
      result.current.addView(globalChat);
    });
    expect(result.current.activeConversationId).toBe("global");
    expect(result.current.layout.views.map((view) => view.id)).toEqual([globalChat.id]);
    expect(result.current.layout.panes).toHaveLength(1);
    await act(async () => {
      await result.current.navigateConversation("a");
    });
    expect(result.current.layout.views.map((view) => view.id)).toEqual([owner.id, paneChat.id]);
    expect(result.current.layout.panes).toHaveLength(2);
  });

  it.each([false, true])("retains its pane and owner when hidden=%s", async (hidden) => {
    const layout = addDockView(createDockLayout([owner]), draft, { edge: "right" });
    const { result } = renderHook(() =>
      useDockLayout({ scope, initialLayout: layout, storage: null }),
    );
    await act(async () => {
      result.current.saveChatLayout("a");
    });
    const pane = dockPaneForView(result.current.layout, draft.id)!.id;
    if (hidden)
      await act(async () => {
        await result.current.navigateConversation("b");
      });
    act(() => {
      expect(result.current.promoteConversationDraft(draft.id, "fresh", "Fresh")).toBe(true);
    });
    expect(result.current.activeConversationId).toBe(hidden ? "b" : "a");
    if (hidden) {
      expect(result.current.layout.views).not.toContainEqual(
        expect.objectContaining({ id: "conversation:fresh" }),
      );
      await act(async () => {
        await result.current.navigateConversation("a");
      });
    }
    expect(dockPaneForView(result.current.layout, "conversation:fresh")?.id).toBe(pane);
    expect(result.current.layout.panes).toHaveLength(2);
    expect(result.current.retainedViews.find((view) => view.id === draft.id)).toBeUndefined();
    expect(
      result.current.layout.views.find((view) => view.id === "conversation:fresh")?.resource,
    ).toEqual({ conversationId: "fresh" });
  });

  it("ignores a completion after the draft closes", async () => {
    const { result } = renderHook(() =>
      useDockLayout({ scope, initialLayout: createDockLayout([draft]), storage: null }),
    );
    await act(async () => {
      await result.current.closeView(draft.id);
    });
    act(() => {
      expect(result.current.promoteConversationDraft(draft.id, "fresh")).toBe(false);
    });
    expect(result.current.layout.views).toEqual([]);
  });

  it("rejects a callback retained across account changes", () => {
    const { result, rerender } = renderHook(
      ({ accountId }) =>
        useDockLayout({
          scope: { ...scope, accountId },
          initialLayout: createDockLayout([draft]),
          storage: null,
        }),
      { initialProps: { accountId: "first" } },
    );
    const promote = result.current.promoteConversationDraft;
    rerender({ accountId: "second" });
    act(() => {
      expect(promote(draft.id, "fresh")).toBe(false);
    });
    expect(result.current.layout.views).toEqual([draft]);
  });

  it("promotes a pinned draft once and retains its reservation", () => {
    const { result } = renderHook(() =>
      useDockLayout({
        scope,
        initialLayout: addDockView(createDockLayout([owner]), draft, { edge: "right" }),
        storage: null,
      }),
    );
    act(() => {
      result.current.pinView(draft.id);
    });
    const pane = dockPaneForView(result.current.layout, draft.id)!.id;
    act(() => {
      expect(result.current.promoteConversationDraft(draft.id, "fresh")).toBe(true);
    });
    expect(result.current.pinnedViewIds).toEqual(["conversation:fresh"]);
    expect(dockPaneForView(result.current.layout, "conversation:fresh")?.id).toBe(pane);
    act(() => {
      expect(result.current.promoteConversationDraft(draft.id, "fresh")).toBe(false);
    });
  });
});
