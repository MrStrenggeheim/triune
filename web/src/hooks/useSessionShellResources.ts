// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { shellState } from "@/lib/shellState";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackgroundTaskInfo } from "@/lib/types";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import { isTempConvId } from "@/lib/tempConversationId";

export interface SessionShellResource extends BackgroundTaskInfo {
  /** Optional exact alias published by the activity producer. */
  activity_id?: string | null;
  output?: string | null;
  live_error?: string | null;
}

export interface SessionShellResources {
  data: SessionShellResource[];
  warning?: unknown;
}

export function shellResourceMatchesActivity(
  task: SessionShellResource,
  entry: {
    id: string;
    session_id: string;
    kind: "command" | "terminal";
    source?: BackgroundTaskInfo["source"];
    source_call_id?: string | null;
  },
  sessionId: string,
): boolean {
  if (
    entry.session_id !== sessionId ||
    (task.session_id != null && task.session_id !== sessionId) ||
    !shellResourceKey(task)
  )
    return false;
  if (task.source === "registered_terminal")
    return entry.kind === "terminal" && entry.id === task.resource_id;
  return (
    entry.kind === "command" &&
    (task.activity_id === entry.id ||
      (entry.source === task.source && entry.source_call_id === task.resource_id))
  );
}

function pathSegment(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function shellResourceKey(task: BackgroundTaskInfo): string | undefined {
  return ["codex_native", "claude_native", "registered_terminal"].includes(task.source ?? "") &&
    typeof task.resource_id === "string" &&
    task.resource_id.length > 0
    ? `${task.source}:${task.resource_id}`
    : undefined;
}

export function shellResourcePath(
  sessionId: string | null | undefined,
  task: BackgroundTaskInfo,
): string | undefined {
  if (
    !sessionId ||
    isTempConvId(sessionId) ||
    !shellResourceKey(task) ||
    (task.session_id != null && task.session_id !== sessionId)
  )
    return undefined;
  return `/v1/sessions/${pathSegment(sessionId)}/resources/shells/${task.source}/${pathSegment(task.resource_id!)}`;
}

export function shellStopRequest(
  sessionId: string,
  task: BackgroundTaskInfo,
): { url: string; method: "POST" } | undefined {
  const path = shellResourcePath(sessionId, task);
  if (
    !path ||
    task.resource_url !== path ||
    task.can_stop !== true ||
    task.stop_url !== `${path}/stop` ||
    task.stop_method !== "POST" ||
    !["running", "idle", "in_progress"].includes(task.status ?? "")
  )
    return undefined;
  return { url: task.stop_url, method: "POST" };
}

function readResource(raw: unknown, sessionId: string): SessionShellResource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid shell resource");
  const task = raw as SessionShellResource;
  for (const value of [
    task.id,
    task.type,
    task.status,
    task.description,
    task.command,
    task.output,
    task.output_preview,
    task.activity_id,
  ]) {
    if (value != null && typeof value !== "string") throw new Error("Invalid shell resource text");
  }
  const path = shellResourcePath(sessionId, task);
  if (
    !path ||
    (task.session_id != null && task.session_id !== sessionId) ||
    (task.resource_url != null && task.resource_url !== path)
  )
    throw new Error("Shell resource identity mismatch");
  return {
    ...task,
    id: task.id ?? undefined,
    type: task.type ?? undefined,
    status: task.status ?? undefined,
    description: task.description ?? undefined,
    command: task.command ?? undefined,
    resource_url: path,
    can_open: task.can_open === true,
    can_stop: !!shellStopRequest(sessionId, task),
  };
}

export function sessionShellResourcesKey(sessionId: string | null | undefined) {
  return ["session-shell-resources", resourceViewStorageScope(), sessionId || null] as const;
}

export function sessionShellResourceKey(sessionId: string, task: BackgroundTaskInfo) {
  return [
    "session-shell-resource",
    resourceViewStorageScope(),
    sessionId,
    shellResourceKey(task),
  ] as const;
}

/** One account-scoped inventory shared by visible Orchestration and open popups. */
export function useSessionShellResources(
  sessionId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const client = useQueryClient();
  const capturedId = sessionId && !isTempConvId(sessionId) ? sessionId : null;
  const observing = enabled && !!capturedId;
  const queryKey = sessionShellResourcesKey(capturedId);
  const query = useQuery<SessionShellResources>({
    queryKey,
    queryFn: async ({ signal }) => {
      const response = await authenticatedFetch(
        `/v1/sessions/${pathSegment(capturedId!)}/resources/shells`,
        { signal },
      );
      if (!response.ok) throw await apiErrorFromResponse(response);
      const payload = await response.json();
      if (!Array.isArray(payload.data)) throw new Error("Invalid shell inventory");
      return {
        data: payload.data.map((task: unknown) => readResource(task, capturedId!)),
        warning: payload.warning,
      };
    },
    enabled: observing,
    staleTime: 2_000,
    refetchInterval: observing ? 5_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
    throwOnError: false,
  });
  const scope = queryKey[1];
  useEffect(() => {
    const capturedKey = ["session-shell-resources", scope, capturedId];
    if (
      !observing &&
      !client.getQueryCache().find({ queryKey: capturedKey, exact: true })?.isActive()
    )
      void client.cancelQueries({ queryKey: capturedKey, exact: true });
  }, [client, observing, capturedId, scope]);
  return query;
}

/** A resource read updates output without attaching to or creating a terminal. */
export function useSessionShellResource(
  sessionId: string,
  task: BackgroundTaskInfo,
  active: boolean,
) {
  const client = useQueryClient();
  const path = shellResourcePath(sessionId, task);
  const queryKey = sessionShellResourceKey(sessionId, task);
  const scope = queryKey[1];
  const identity = queryKey[3];
  const query = useQuery<SessionShellResource>({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!path || (task.resource_url != null && task.resource_url !== path))
        throw new Error("Shell resource identity mismatch");
      const response = await authenticatedFetch(path, { signal });
      if (!response.ok) throw await apiErrorFromResponse(response);
      const resource = readResource(await response.json(), sessionId);
      if (shellResourceKey(resource) !== shellResourceKey(task))
        throw new Error("Shell resource identity mismatch");
      return resource;
    },
    enabled: active && !!path,
    initialData: () =>
      client
        .getQueryData<SessionShellResources>(sessionShellResourcesKey(sessionId))
        ?.data.find((resource) => shellResourceKey(resource) === identity),
    initialDataUpdatedAt: () =>
      client.getQueryState(sessionShellResourcesKey(sessionId))?.dataUpdatedAt,
    staleTime: 2_000,
    refetchInterval: active && !!path ? 5_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
    throwOnError: false,
  });
  useEffect(() => {
    const capturedKey = ["session-shell-resource", scope, sessionId, identity];
    if (!active && !client.getQueryCache().find({ queryKey: capturedKey, exact: true })?.isActive())
      void client.cancelQueries({ queryKey: capturedKey, exact: true });
  }, [active, client, scope, sessionId, identity]);
  return query;
}

/** Only service observations can grant controls; legacy labels never prove identity. */
export function mergeShellResources(
  reported: BackgroundTaskInfo[],
  observed: SessionShellResource[],
  limit: number,
  controlsCurrent: boolean,
): BackgroundTaskInfo[] {
  if (limit <= 0) return [];
  const liveById = new Map(observed.map((task) => [shellResourceKey(task), task]));
  const used = new Set<string>();
  const rows: BackgroundTaskInfo[] = [];
  for (const task of reported) {
    const key = shellResourceKey(task);
    if (key && used.has(key)) continue;
    if (key) used.add(key);
    const current = key ? liveById.get(key) : undefined;
    const reportedEnded = shellState({ status: task.status }).ended;
    const observedEnded = shellState({ status: current?.status }).ended;
    const status =
      task.status === "stopped" || (reportedEnded && !observedEnded)
        ? task.status
        : (current?.status ?? task.status);
    const ended = shellState({ status }).ended;
    rows.push({
      ...task,
      ...current,
      command: current?.command ?? task.command,
      status,
      exit_code: observedEnded
        ? (current?.exit_code ?? task.exit_code)
        : reportedEnded
          ? task.exit_code
          : (current?.exit_code ?? task.exit_code),
      can_stop: !ended && controlsCurrent && current?.can_stop === true,
    });
    if (rows.length >= limit) break;
  }
  for (const task of observed) {
    const key = shellResourceKey(task)!;
    if (rows.length >= limit) break;
    if (used.has(key) || !["running", "idle", "in_progress"].includes(task.status ?? "")) continue;
    rows.push({ ...task, can_stop: controlsCurrent && task.can_stop === true });
    used.add(key);
  }
  return rows;
}
