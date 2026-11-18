import { useLayoutEffect, useState } from "react";
import { ChatPage } from "@/pages/ChatPage";
import { migrateConversationDraft } from "./conversationDraft";

/** Restore shared drafts before the existing full composer mounts. */
export function ScopedConversationSurface({
  conversationId,
  visible,
  preserveSeed = false,
}: {
  conversationId: string;
  visible: boolean;
  preserveSeed?: boolean;
}) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    migrateConversationDraft(conversationId, preserveSeed);
    setReady(true);
  }, [conversationId, preserveSeed]);
  if (!ready) return null;
  return <ChatPage conversationId={conversationId} visible={visible} />;
}
