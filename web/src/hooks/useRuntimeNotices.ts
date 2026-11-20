// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";
import { ApiError, apiErrorFromResponse } from "@/lib/sessionsApi";
import { isTempConvId } from "@/lib/tempConversationId";
import { RESOURCE_POLL_MS, usePollingInterval } from "./usePollingInterval";
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
  category?: "quota" | "provider";
  source_kind?: "native" | "sdk" | "unknown";
  native_subtype?: string | null;
  request_id?: string | null;
  blocking?: boolean | null;
  observed_at?: number | null;
}

export interface RuntimeQuota {
  id: string;
  provider: string;
  window: string;
  used_percent: number | null;
  reset_at: number | null;
  window_minutes: number | null;
  status: string | null;
  observed_at: number;
  source_kind: "native" | "sdk" | "unknown";
}

interface RuntimeObservations {
  data: RuntimeNotice[];
  quotas: RuntimeQuota[];
}

export function runtimeNoticeRevision(notice: RuntimeNotice): string {
  return (
    notice.revision ??
    JSON.stringify([
      notice.severity,
      notice.title,
      notice.message,
      notice.reset_at,
      notice.category,
      notice.native_subtype,
      notice.request_id,
      notice.blocking,
    ])
  );
}

function readNotices(payload: unknown): RuntimeObservations {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { data?: unknown }).data)
  )
    throw new Error("Could not load agent notices.");
  const data = (payload as { data: unknown[] }).data.slice(0, 32).map((raw) => {
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
      (notice.requires_action != null && typeof notice.requires_action !== "boolean") ||
      (notice.category != null && !["quota", "provider"].includes(notice.category)) ||
      (notice.source_kind != null && !["native", "sdk", "unknown"].includes(notice.source_kind)) ||
      (notice.native_subtype != null && typeof notice.native_subtype !== "string") ||
      (notice.request_id != null && typeof notice.request_id !== "string") ||
      (notice.blocking != null && typeof notice.blocking !== "boolean") ||
      (notice.observed_at != null && !Number.isFinite(notice.observed_at))
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
      category: notice.category,
      source_kind: notice.source_kind,
      native_subtype: notice.native_subtype?.slice(0, 160),
      request_id: notice.request_id?.slice(0, 256),
      blocking: notice.blocking,
      observed_at: notice.observed_at,
    };
  });
  const rawQuotas = (payload as { quotas?: unknown }).quotas ?? [];
  if (!Array.isArray(rawQuotas)) throw new Error("Invalid agent usage.");
  const quotas = rawQuotas.slice(0, 32).map((raw): RuntimeQuota => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid agent usage.");
    const quota = raw as RuntimeQuota;
    if (
      typeof quota.id !== "string" ||
      !quota.id ||
      typeof quota.provider !== "string" ||
      typeof quota.window !== "string" ||
      !Number.isFinite(quota.observed_at) ||
      (quota.used_percent != null &&
        (typeof quota.used_percent !== "number" ||
          !Number.isFinite(quota.used_percent) ||
          quota.used_percent < 0 ||
          quota.used_percent > 100)) ||
      (quota.reset_at != null &&
        (typeof quota.reset_at !== "number" || !Number.isFinite(quota.reset_at))) ||
      (quota.window_minutes != null &&
        (typeof quota.window_minutes !== "number" ||
          !Number.isFinite(quota.window_minutes) ||
          quota.window_minutes < 0)) ||
      (quota.status != null && typeof quota.status !== "string") ||
      (quota.source_kind != null && !["native", "sdk", "unknown"].includes(quota.source_kind))
    )
      throw new Error("Invalid agent usage.");
    return {
      id: quota.id.slice(0, 256),
      provider: quota.provider.slice(0, 48),
      window: quota.window.slice(0, 160),
      used_percent: quota.used_percent ?? null,
      reset_at: quota.reset_at ?? null,
      window_minutes: quota.window_minutes ?? null,
      status: quota.status?.slice(0, 80) ?? null,
      observed_at: quota.observed_at,
      source_kind: quota.source_kind ?? "unknown",
    };
  });
  return { data, quotas };
}

/** View-scoped observation; dismissing a notice never responds to the native runtime. */
export function useRuntimeNotices(conversationId: string | null, active: boolean) {
  const client = useQueryClient();
  const sessionId = conversationId && !isTempConvId(conversationId) ? conversationId : null;
  const scope = resourceViewStorageScope();
  const queryKey = ["runtime-notices", scope, sessionId];
  const storageKey = `runtime-notice-dismissals:${sessionId}`;
  const refetchInterval = usePollingInterval({
    active: active && !!sessionId,
    intervalMs: RESOURCE_POLL_MS,
  });
  const query = useQuery<RuntimeObservations>({
    queryKey,
    queryFn: async ({ signal }) => {
      const response = await authenticatedFetch(
        `/v1/sessions/${encodeURIComponent(sessionId!)}/runtime-notices`,
        { signal },
      );
      if (response.status === 404) return { data: [], quotas: [] };
      if (!response.ok) throw await apiErrorFromResponse(response);
      return readNotices(await response.json());
    },
    enabled: active && !!sessionId,
    staleTime: 5000,
    refetchInterval,
    retry: false,
  });
  const dismissed = readResourceViewState<Record<string, string>>(storageKey) ?? {};
  const denied = query.error instanceof ApiError && [401, 403].includes(query.error.status);
  const notices = (denied ? [] : (query.data?.data ?? [])).filter(
    (notice) =>
      !(notice.category === "quota" && notice.severity === "info") &&
      dismissed[notice.id] !== runtimeNoticeRevision(notice),
  );
  function dismiss(notice: RuntimeNotice) {
    if (resourceViewStorageScope() !== scope) return;
    const previous = readResourceViewState<Record<string, string>>(storageKey) ?? {};
    const entries = Object.entries({
      ...previous,
      [notice.id]: runtimeNoticeRevision(notice),
    }).slice(-100);
    writeResourceViewState(storageKey, Object.fromEntries(entries));
    client.setQueryData<RuntimeObservations>(queryKey, (items) =>
      items ? { ...items, data: items.data.filter((item) => item.id !== notice.id) } : items,
    );
  }
  return {
    ...query,
    notices,
    quotas: denied ? [] : (query.data?.quotas ?? []),
    accessDenied: denied,
    dismiss,
  };
}
