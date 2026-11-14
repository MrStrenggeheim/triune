// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { isTempConvId } from "@/lib/tempConversationId";
import {
  readResourceViewState,
  resourceViewStorageScope,
  writeResourceViewState,
} from "@/lib/resourceViewStorage";

export interface RuntimeNotice {
  id: string;
  revision?: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "error";
  provider?: string;
  created_at: number;
  reset_at?: number | null;
  requires_action?: boolean;
}

export function runtimeNoticeRevision(notice: RuntimeNotice): string {
  return (
    notice.revision ??
    JSON.stringify([notice.severity, notice.title, notice.message, notice.reset_at])
  );
}

function readNotices(payload: unknown): RuntimeNotice[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { data?: unknown }).data)
  )
    throw new Error("Could not load agent notices.");
  return (payload as { data: unknown[] }).data.slice(0, 32).map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid agent notice.");
    const notice = raw as RuntimeNotice;
    if (
      typeof notice.id !== "string" ||
      !notice.id ||
      notice.id.length > 256 ||
      typeof notice.title !== "string" ||
      typeof notice.message !== "string" ||
      !["info", "warning", "error"].includes(notice.severity) ||
      typeof notice.created_at !== "number" ||
      !Number.isFinite(notice.created_at) ||
      (notice.revision != null && typeof notice.revision !== "string") ||
      (notice.provider != null && typeof notice.provider !== "string") ||
      (notice.reset_at != null && !Number.isFinite(notice.reset_at)) ||
      (notice.requires_action != null && typeof notice.requires_action !== "boolean")
    )
      throw new Error("Invalid agent notice.");
    return {
      id: notice.id,
      revision: notice.revision,
      title: notice.title.slice(0, 160),
      message: notice.message.slice(0, 2000),
      severity: notice.severity,
      provider: notice.provider?.slice(0, 48),
      created_at: notice.created_at,
      reset_at: notice.reset_at,
      requires_action: notice.requires_action,
    };
  });
}

/** View-scoped observation; dismissing a notice never responds to the native runtime. */
export function useRuntimeNotices(conversationId: string | null, active: boolean) {
  const client = useQueryClient();
  const sessionId = conversationId && !isTempConvId(conversationId) ? conversationId : null;
  const scope = resourceViewStorageScope();
  const queryKey = ["runtime-notices", scope, sessionId];
  const storageKey = `runtime-notice-dismissals:${sessionId}`;
  const query = useQuery<RuntimeNotice[]>({
    queryKey,
    queryFn: async ({ signal }) => {
      const response = await authenticatedFetch(
        `/v1/sessions/${encodeURIComponent(sessionId!)}/runtime-notices`,
        { signal },
      );
      if (response.status === 404) return [];
      if (!response.ok) throw await apiErrorFromResponse(response);
      return readNotices(await response.json());
    },
    enabled: active && !!sessionId,
    staleTime: 5000,
    refetchInterval: active && sessionId ? 5000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const dismissed = readResourceViewState<Record<string, string>>(storageKey) ?? {};
  const notices = (query.data ?? []).filter(
    (notice) => dismissed[notice.id] !== runtimeNoticeRevision(notice),
  );
  function dismiss(notice: RuntimeNotice) {
    if (resourceViewStorageScope() !== scope) return;
    const previous = readResourceViewState<Record<string, string>>(storageKey) ?? {};
    const entries = Object.entries({
      ...previous,
      [notice.id]: runtimeNoticeRevision(notice),
    }).slice(-100);
    writeResourceViewState(storageKey, Object.fromEntries(entries));
    client.setQueryData<RuntimeNotice[]>(queryKey, (items) =>
      items?.filter((item) => item.id !== notice.id),
    );
  }
  return { ...query, notices, dismiss };
}
