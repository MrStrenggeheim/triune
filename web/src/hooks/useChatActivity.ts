// Modified for Triune.
import { useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { isTempConvId } from "@/lib/tempConversationId";

export interface ChatActivityEntry {
  id: string;
  kind: "terminal" | "command";
  session_id: string;
  terminal_id?: string | null;
  name: string;
  state: "running" | "idle" | "exited" | "disconnected" | "unknown";
  started_at?: string | number | null;
  ended_at?: string | number | null;
  exit_status?: number | null;
  output?: string | null;
  owner_kind: "chat" | "workspace";
  owner_id: string;
  workspace_id?: string | null;
  parent_agent_id?: string | null;
}

export interface ChatActivityCoverage {
  terminals: string;
  history: string;
  output: string;
  non_tty_commands: string;
  native_vendor_shells: string;
  max_entries: number;
  max_output_bytes: number;
}

export interface ChatActivityResponse {
  data: ChatActivityEntry[];
  coverage: ChatActivityCoverage | string;
  warning?: string | null;
}

/** Chat provenance only; workspace terminal inventory is intentionally separate. */
export function useChatActivity(
  conversationId: string | null,
  options: { enabled?: boolean } = {},
) {
  const sessionId = isTempConvId(conversationId) ? null : conversationId;
  return useQuery<ChatActivityResponse>({
    queryKey: ["chat-activity", sessionId],
    queryFn: async ({ signal }) => {
      const response = await authenticatedFetch(
        `/v1/sessions/${encodeURIComponent(sessionId!)}/activity`,
        { signal },
      );
      if (!response.ok) throw await apiErrorFromResponse(response);
      return response.json();
    },
    enabled: options.enabled !== false && !!sessionId,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
}
