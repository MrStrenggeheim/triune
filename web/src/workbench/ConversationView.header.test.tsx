// Modified for Triune.
import { Profiler, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationView } from "./ConversationView";
import { BubbleView } from "@/components/chat/chatBubbleParts";
import type { Bubble } from "@/lib/renderItems";
import { DockWorkspace, type DockWorkspaceProps } from "./DockWorkspace";
import { addDockView, createDockLayout, resizeDockSplit, type DockView } from "./dockLayout";
import { WorkbenchProvider } from "./WorkbenchContext";
import { CapturedFileActions } from "./CapturedFileActions";

vi.mock("./ScopedConversationSurface", () => ({ ScopedConversationSurface: () => null }));
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    session: {
      id: "chat",
      title: "Chat A",
      status: "idle",
      labels: {},
      createdAt: 1,
      permissionLevel: 4,
      agentId: "agent",
      workspace: "/project",
      parentSessionId: null,
    },
  }),
}));
vi.mock("@/hooks/useAgents", () => ({ useSessionAgent: () => ({ data: undefined }) }));
vi.mock("@/hooks/usePermissions", () => ({ useCanEdit: () => true }));
vi.mock("@/hooks/useSessionActionRestrictions", () => ({
  useSessionActionRestrictions: () => ({}),
}));
vi.mock("@/hooks/RunnerHealthProvider", () => ({
  useRunnerHealthRegistration: () => {},
  useSessionRunnerOnline: () => true,
}));
vi.mock("@/hooks/useBrowserAgentRelay", () => ({ useBrowserAgentRelay: () => {} }));
vi.mock("@/hooks/useUiOpenFile", () => ({ useUiOpenFile: () => {} }));
vi.mock("@/shell/useWorkspaceResources", () => ({
  useWorkspaceResources: () => ({ showFilesPanel: false }),
}));
vi.mock("@/shell/ContextSearchContext", () => ({ useContextSearch: () => null }));
vi.mock("@/shell/HeaderConversationMenu", () => ({
  HeaderConversationMenu: ({ onShare }: { onShare: () => void }) => (
    <button type="button" onClick={onShare}>
      Share
    </button>
  ),
}));
vi.mock("@/components/PermissionsModal", () => ({
  PermissionsModal: ({ open }: { open: boolean }) => (open ? <div>Sharing dialog</div> : null),
}));
vi.mock("./viewCommands", () => ({ useViewCommands: () => {} }));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

it("keeps its own header without remounting the chat", () => {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Draft() {
    const [text, setText] = useState("");
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return (
      <textarea aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />
    );
  }
  const view = () => (
    <ConversationView conversationId="chat" focused>
      <Draft />
    </ConversationView>
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container, rerender, unmount } = render(view(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  const input = screen.getByRole("textbox", { name: "Draft" });
  fireEvent.change(input, { target: { value: "Unsent message" } });
  expect(
    within(container).getByRole("navigation", { name: "Conversation ancestry" }),
  ).toHaveTextContent("Chat A");
  rerender(view());
  fireEvent.click(within(container).getByRole("button", { name: "Share" }));
  expect(screen.getByText("Sharing dialog")).toBeInTheDocument();
  expect(
    within(container).getByRole("navigation", { name: "Conversation ancestry" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
  expect(input).toHaveValue("Unsent message");
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
  unmount();
  expect(unmounted).toHaveBeenCalledOnce();
});

it("does not commit an unchanged assistant bubble when focus, visibility or a header dialog changes", () => {
  const committed = vi.fn();
  const bubble: Extract<Bubble, { kind: "assistant" }> = {
    kind: "assistant",
    responseId: "response",
    stableId: "response",
    lifecycle: "completed",
    error: null,
    items: [{ kind: "text", itemId: "answer", text: "Retained answer", final: true }],
  };
  const content = (
    <Profiler id="retained-assistant" onRender={committed}>
      <BubbleView bubble={bubble} isLastAssistant={false} />
    </Profiler>
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (visible: boolean, focused: boolean) => (
    <ConversationView conversationId="chat" visible={visible} focused={focused}>
      {content}
    </ConversationView>
  );
  const { rerender } = render(view(true, true), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  expect(committed).toHaveBeenCalled();
  committed.mockClear();
  rerender(view(false, false));
  rerender(view(true, true));
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  expect(screen.getByText("Sharing dialog")).toBeInTheDocument();
  expect(committed).not.toHaveBeenCalled();
});

it("keeps hidden assistant bubbles and resources at zero commits for an unrelated file opening and resize", () => {
  const committed = vi.fn();
  const resourceRender = vi.fn();
  const openView = vi.fn();
  const registerGuard = () => () => {};
  const a: DockView = {
    id: "a",
    title: "A",
    kind: "conversation",
    resource: { conversationId: "a" },
  };
  const b: DockView = {
    id: "b",
    title: "B",
    kind: "conversation",
    resource: { conversationId: "b" },
  };
  const bubble: Extract<Bubble, { kind: "assistant" }> = {
    kind: "assistant",
    responseId: "answer",
    stableId: "answer",
    lifecycle: "completed",
    error: null,
    items: [{ kind: "text", itemId: "answer", text: "Retained answer", final: true }],
  };
  const renderView: DockWorkspaceProps["renderView"] = (view, state) => {
    resourceRender(view.id);
    return view.kind === "conversation" ? (
      <CapturedFileActions
        conversationId={view.id}
        viewId={view.id}
        openView={openView}
        registerGuard={registerGuard}
      >
        <ConversationView conversationId={view.id} visible={state.visible} focused={state.focused}>
          <Profiler id={view.id} onRender={(id) => committed(id)}>
            <BubbleView bubble={bubble} isLastAssistant={false} />
          </Profiler>
        </ConversationView>
      </CapturedFileActions>
    ) : (
      <p>File editor</p>
    );
  };
  let layout = createDockLayout([a]);
  const view = () => (
    <WorkbenchProvider
      value={{
        openConversation: () => {},
        openView: () => {},
        focusedConversationId: "a",
        openConversationIds: ["a"],
      }}
    >
      <DockWorkspace
        layout={layout}
        renderView={renderView}
        retainedViews={[a, b]}
        onLayoutChange={() => {}}
      />
    </WorkbenchProvider>
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { rerender } = render(view(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  committed.mockClear();
  resourceRender.mockClear();
  layout = addDockView(
    layout,
    { id: "file", kind: "preview", title: "File", resource: { path: "/file.ts" } },
    { edge: "right" },
  );
  rerender(view());
  expect(resourceRender.mock.calls.map(([id]) => id)).toEqual(["a", "file"]);
  expect(committed.mock.calls.map(([id]) => id)).not.toContain("b");
  committed.mockClear();
  resourceRender.mockClear();
  layout = resizeDockSplit(layout, [], 0.7);
  rerender(view());
  expect(resourceRender).not.toHaveBeenCalled();
  expect(committed).not.toHaveBeenCalled();
});
