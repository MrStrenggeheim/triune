// Modified for Triune.
import { useEffect } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  conversationRegistry,
  ConversationRegistry,
  MAX_CLEAN_INACTIVE_HISTORY,
} from "@/store/conversationRegistry";
import {
  readTranscriptReaderCheckpoint,
  rememberTranscriptReaderCheckpoint,
} from "@/lib/transcriptReaderCheckpoint";
import { createDockLayout, type DockView } from "./dockLayout";
import { useDockHistoryOwners, useDockLayout } from "./useDockLayout";

const view = (id: string): DockView => ({
  id: `conversation:${id}`,
  kind: "conversation",
  title: id,
  resource: { conversationId: id },
});
afterEach(() => {
  cleanup();
  conversationRegistry.clear();
});

it("expires only the oldest of 21 Undo owners and transfers ownership before reopening", async () => {
  const registry = new ConversationRegistry();
  const entries = Array.from({ length: 21 }, (_, index) => registry.acquire(`undo-${index}`));
  // Establish the list before creating cache pressure, just as close commits do.
  const hook = renderHook(({ views }) => useDockHistoryOwners(views, "account", registry), {
    initialProps: { views: entries.slice(1).map((entry) => view(entry.id)) },
  });
  const retained = entries.at(-1)!;
  for (let i = 0; i < 100; i++) registry.acquire(`clean-${i}`);
  expect(registry.ids()).toHaveLength(20 + MAX_CLEAN_INACTIVE_HISTORY);
  expect(entries[0]!.disposed).toBe(true);
  entries.slice(1).forEach((entry) => expect(registry.peek(entry.id)).toBe(entry));
  const releaseMounted = registry.retain(retained.id);
  hook.rerender({ views: entries.slice(1, -1).map((entry) => view(entry.id)) });
  expect(registry.peek(retained.id)).toBe(retained);
  hook.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(registry.ids()).toHaveLength(MAX_CLEAN_INACTIVE_HISTORY + 1);
  expect(registry.peek(retained.id)).toBe(retained);
  releaseMounted();
  registry.clear();
});

it("keeps saved layout and editor/terminal identities while clean transcript entries retire", async () => {
  const terminal: DockView = {
    id: "terminal:shell",
    kind: "terminal",
    title: "Shell",
    resource: { sessionId: "shell" },
  };
  const editor: DockView = {
    id: "file:buffer",
    kind: "file",
    title: "File",
    resource: { path: "/repo/file.txt", hostId: "host" },
  };
  const hook = renderHook(() =>
    useDockLayout({
      scope: { accountId: "a", serverId: "s", clientId: "browser" },
      initialLayout: createDockLayout([view("old"), terminal, editor]),
      storage: null,
    }),
  );
  act(() => hook.result.current.saveChatLayout("old"));
  const old = conversationRegistry.acquire("old");
  await act(async () => {
    await hook.result.current.navigateConversation("new");
  });
  for (let i = 0; i < 100; i++) conversationRegistry.acquire(`clean-${i}`);
  expect(old.disposed).toBe(true);
  expect(hook.result.current.savedConversationIds).toContain("old");
  await act(async () => {
    await hook.result.current.navigateConversation("old");
  });
  expect(hook.result.current.layout.views).toEqual([view("old"), terminal, editor]);
});

it("hands Undo history to a reopened child before releasing the old lease", () => {
  const registry = new ConversationRegistry();
  const entry = registry.acquire("handoff");
  const undo = [view("handoff")];
  function MountedView() {
    useEffect(() => {
      expect(registry.peek("handoff")).toBe(entry);
      return registry.retain("handoff");
    }, []);
    return null;
  }
  function Owner({ reopened }: { reopened: boolean }) {
    useDockHistoryOwners(reopened ? [] : undo, "scope", registry);
    return reopened ? <MountedView /> : null;
  }
  const rendered = render(<Owner reopened={false} />);
  for (let i = 0; i < 100; i++) registry.acquire(`pressure-${i}`);
  rendered.rerender(<Owner reopened />);
  expect(registry.peek("handoff")).toBe(entry);
  rendered.unmount();
  registry.clear();
});

it("keeps a conversation reader after its last saved view and Undo entry expire", async () => {
  const id = "last-saved-reader";
  const savedView = { ...view(id), id: "expired-saved-view" };
  const snapshot = {
    atBottom: false as const,
    anchorKey: "user:anchor",
    anchorItemId: "anchor",
    anchorOffset: -12,
    fallbackOffset: 333,
  };
  const oldEntry = conversationRegistry.acquire(id);
  rememberTranscriptReaderCheckpoint(
    id,
    { snapshot, expandedHistoryId: "history", originalItemIds: ["source"] },
    savedView.id,
  );
  const hook = renderHook(
    ({ undoViews }) =>
      useDockLayout({
        scope: { accountId: "owner", serverId: "server", clientId: "browser" },
        initialLayout: createDockLayout([savedView]),
        storage: null,
        undoViews,
      }),
    { initialProps: { undoViews: [savedView] as DockView[] } },
  );
  act(() => hook.result.current.saveChatLayout(id));
  await act(async () => {
    expect(await hook.result.current.closeView(savedView.id)).toBe(true);
  });
  act(() => {
    hook.result.current.useSharedLayout();
    hook.result.current.setLayout(createDockLayout());
  });
  expect(hook.result.current.retainedViews).not.toContainEqual(savedView);
  for (let i = 0; i < 100; i++) conversationRegistry.acquire(`last-owner-pressure-${i}`);
  expect(oldEntry.disposed).toBe(false);
  hook.rerender({ undoViews: [] });
  await act(async () => {
    await Promise.resolve();
  });
  expect(oldEntry.disposed).toBe(true);
  const reopened = { ...savedView, id: "new-saved-view" };
  act(() => hook.result.current.addView(reopened));
  expect(hook.result.current.layout.views).toContainEqual(reopened);
  expect(readTranscriptReaderCheckpoint(id, reopened.id)).toMatchObject({
    snapshot,
    expandedHistoryId: "history",
    originalItemIds: ["source"],
  });
  expect(conversationRegistry.acquire(id)).not.toBe(oldEntry);
});
