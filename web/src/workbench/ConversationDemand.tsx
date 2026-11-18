// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useLayoutEffect, useRef } from "react";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import { useSession } from "@/hooks/useSession";
import { declareConversationDemand } from "@/store/conversationDemand";

/** Declare view interest. The tab reconciles the union after the layout commit. */
export function useConversationDemand(id: string | undefined, ready: boolean, focused: boolean) {
  const owner = useRef(Symbol());
  const scope = resourceViewStorageScope();
  useLayoutEffect(() => {
    if (id) declareConversationDemand(owner.current, { id, ready, focused, scope });
    const token = owner.current;
    return () => declareConversationDemand(token);
  }, [id, ready, focused, scope]);
}

export function VisibleConversation({ id, focused }: { id: string; focused: boolean }) {
  const metadata = useSession(id);
  useConversationDemand(id, !metadata.isLoading, focused);
  return null;
}
