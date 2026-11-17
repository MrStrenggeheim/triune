import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setPendingInitialPrompt, useChatStore } from "@/store/chatStore";
import { conversationRegistry } from "@/store/conversationRegistry";
import { ScopedChatStoreProvider } from "./ScopedChatStore";
import { useScopedInitialPrompt } from "./useScopedInitialPrompt";

const original = useChatStore.getState();
const send = vi.fn().mockResolvedValue(undefined);
const skill = vi.fn().mockResolvedValue(undefined);
const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <ScopedChatStoreProvider conversationId="first" focused>
      {children}
    </ScopedChatStoreProvider>
  </StrictMode>
);

beforeEach(() => {
  conversationRegistry.clear();
  send.mockClear();
  skill.mockClear();
  useChatStore.setState({ ...original, conversationId: "primary", send, sendSlashCommand: skill });
  conversationRegistry.acquire("first").setState({ loadingConversation: true });
});
afterEach(() => {
  cleanup();
  conversationRegistry.clear();
  useChatStore.setState(original);
});

it("retains a pending prompt through a loading unmount, then sends once to its own conversation", () => {
  const file = new File(["image"], "image.png");
  setPendingInitialPrompt("first", { text: "first prompt", files: [file], skill: null });
  const pending = renderHook(() => useScopedInitialPrompt("first", "first-agent"), { wrapper });
  expect(send).not.toHaveBeenCalled();
  pending.unmount();
  renderHook(() => useScopedInitialPrompt("first", "first-agent"), { wrapper });
  act(() => {
    useChatStore.setState({ conversationId: "different" });
    conversationRegistry.peek("first")!.setState({ loadingConversation: false });
  });
  expect(send).toHaveBeenCalledExactlyOnceWith("first prompt", "first-agent", [file], {
    pinnedConversationId: "first",
  });
  renderHook(() => useScopedInitialPrompt("first", "first-agent"), { wrapper });
  expect(send).toHaveBeenCalledTimes(1);
});

it("pins initial skills and waits for an agent without consuming them early", () => {
  setPendingInitialPrompt("first", {
    text: "/review changes",
    skill: { name: "review", args: "changes" },
  });
  conversationRegistry.peek("first")!.setState({ loadingConversation: false });
  const { rerender } = renderHook(
    (agentId: string | null) => useScopedInitialPrompt("first", agentId),
    { wrapper, initialProps: null as string | null },
  );
  expect(skill).not.toHaveBeenCalled();
  rerender("first-agent");
  expect(skill).toHaveBeenCalledExactlyOnceWith("review", "changes", "first-agent", {
    pinnedConversationId: "first",
  });
});

// These scenarios start after metadata discovery; startup ordering uses real hooks in chatStore.test.ts.
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ isLoading: false }) }));
