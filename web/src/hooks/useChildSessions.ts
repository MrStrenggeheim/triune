// Modified for Triune.
import {
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { authenticatedFetch } from "@/lib/identity";
import { setSessionParent } from "@/lib/sessionHost";
import { isTempConvId } from "@/lib/tempConversationId";

/**
 * Maximum depth of sub-agent nesting the Agents rail renders, counted
 * in levels below the root ("main") session: 1 = children,
 * 2 = grandchildren, 3 = great-grandchildren. Deeper descendants are
 * neither fetched nor rendered.
 */
export const MAX_TREE_DEPTH = 3;

export interface ChildSessionError {
  code: string;
  message: string;
}

/**
 * UI-facing child (sub-agent) session record.
 *
 * Mirrors the ``ChildSessionSummary`` schema returned by
 * ``GET /v1/sessions/{id}/child_sessions``. Only the fields the UI
 * renders or addresses are surfaced — extra wire fields are
 * tolerated and ignored.
 */
export interface ChildSessionInfo {
  statusUnavailable?: boolean;
  created_at?: number;
  updated_at?: number;
  agent_name?: string | null;
  /** Child conversation/session identifier, e.g. ``"conv_child123"``. */
  id: string;
  /** Full title, ``"{tool}:{session_name}"``, e.g. ``"researcher:auth"``. */
  title: string | null;
  /** Human-readable task-derived label, e.g. ``"Investigate auth flow"``. */
  task_summary: string | null;
  /** Sub-agent type prefix, e.g. ``"researcher"``. */
  tool: string | null;
  /** Sub-agent instance name suffix, e.g. ``"auth"``. */
  session_name: string | null;
  /** Session-scoped labels from the child conversation. */
  labels?: Record<string, string>;
  /** Status of the latest task, e.g. ``"completed"``. */
  current_task_status: string | null;
  /** Durable error details from the latest failed child run. */
  last_task_error?: ChildSessionError | null;
  /** True when the latest task is in an active (queued/in_progress) state. */
  busy: boolean;
  /**
   * Single-line preview of the most recent message in the child's
   * conversation, truncated to ~150 chars with a trailing ellipsis.
   * ``null`` when the child has no message items yet.
   */
  last_message_preview: string | null;
  /**
   * Number of approval / input prompts the child is currently blocked
   * on. ``> 0`` means the sub-agent is parked awaiting user input, and
   * the Agents rail renders an "awaiting input" badge for it.
   */
  pending_elicitations_count: number;
  /**
   * Model the intelligent router picked for this sub-agent, e.g.
   * ``"databricks-claude-sonnet-5"``. ``null``/absent when the child was
   * not routed (routing off, or a server that predates the field).
   */
  routed_model?: string | null;
  /**
   * Number of direct children. ``0`` marks a leaf whose list is never
   * fetched; ``null``/absent means unknown, so the list loads when shown.
   */
  child_count?: number | null;
}

/**
 * Wire shape of a single entry in the ``child_sessions`` response.
 * Field set matches the server's ``ChildSessionSummary`` Pydantic
 * model. Extra wire fields are silently ignored.
 */
interface ChildSessionWire {
  created_at?: number;
  updated_at?: number;
  agent_name?: string | null;
  id: string;
  title: string | null;
  task_summary?: string | null;
  tool: string | null;
  session_name: string | null;
  labels?: Record<string, string>;
  current_task_status: string | null;
  last_task_error?: ChildSessionError | null;
  busy: boolean;
  last_message_preview?: string | null;
  pending_elicitations_count?: number;
  routed_model?: string | null;
  child_count?: number | null;
}

interface ChildSessionsResponse {
  object: "list";
  data: ChildSessionWire[];
  has_more?: boolean;
  last_id?: string | null;
}

/**
 * TanStack Query key for a session's child sessions.
 *
 * Exported so the SSE handler can invalidate the same cache entry
 * on ``session.created`` events (live updates).
 */
export function childSessionsQueryKey(conversationId: string): readonly unknown[] {
  return ["conversation", conversationId, "child_sessions"];
}

/** True for any key built by ``childSessionsQueryKey``. */
function isChildSessionsQueryKey(key: readonly unknown[]): boolean {
  return key.length === 3 && key[0] === "conversation" && key[2] === "child_sessions";
}

/**
 * Walk the cached child-session lists to test whether ``targetId`` is
 * a known descendant of ``rootId``.
 *
 * Synchronous and cache-only — never fetches. Used by AppShell's
 * sticky root resolution: when the user clicks a row the rail just
 * rendered, every ancestor's child list is already cached, so
 * membership here means "the rail listed this session under that
 * root" and the root can be held steady while the target's snapshot
 * loads.
 *
 * @param queryClient - The app QueryClient holding child-session caches.
 * @param rootId - Root session whose cached tree to walk, e.g. ``"conv_root"``.
 * @param targetId - Session to look for, e.g. ``"conv_grandchild"``.
 * @param maxDepth - Levels below the root to examine, e.g. ``MAX_TREE_DEPTH``.
 * @returns True when ``targetId`` appears in the cached tree under ``rootId``.
 */
export function cachedTreeContains(
  queryClient: QueryClient,
  rootId: string,
  targetId: string,
  maxDepth: number,
): boolean {
  return findCachedDescendant(queryClient, rootId, targetId, maxDepth) !== null;
}

/**
 * Find ``targetId``'s summary in the cached child-session lists under
 * ``rootId``. Synchronous and cache-only, like ``cachedTreeContains``.
 *
 * @param queryClient - The app QueryClient holding child-session caches.
 * @param rootId - Root session whose cached tree to walk, e.g. ``"conv_root"``.
 * @param targetId - Session to look for, e.g. ``"conv_grandchild"``.
 * @param maxDepth - Levels below the root to examine, e.g. ``MAX_TREE_DEPTH``.
 * @returns The cached summary, or ``null`` when no cached list holds it.
 */
export function findCachedDescendant(
  queryClient: QueryClient,
  rootId: string,
  targetId: string,
  maxDepth: number,
): ChildSessionInfo | null {
  const visited = new Set([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const children = queryClient.getQueryData<ChildSessionInfo[]>(childSessionsQueryKey(id));
      if (!children) continue;
      for (const child of children) {
        if (child.id === targetId) return child;
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Sentinel value used in place of a session id for the rail/panel's
 * "main" entry. The panel resolves it to the currently-viewed parent
 * conversation id at runtime so the same code path serves both main
 * and child sessions.
 */
export const MAIN_EXECUTION_LOG_KEY = "main";

/**
 * Stable tab id for an execution-log entry, used as the panel's
 * Tabs trigger value and as the message between the rail and the
 * panel. Format is ``executionLog:<id>``, where ``<id>`` is either
 * ``"main"`` (the parent session) or a child session id.
 */
export function executionLogTabKey(idOrMain: string): string {
  return `executionLog:${idOrMain}`;
}

function parseChildSessionError(value: unknown): ChildSessionError | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.message !== "string") return null;
  if (!record.code || !record.message) return null;
  return { code: record.code, message: record.message };
}

interface UseChildSessionsResult {
  children: ChildSessionInfo[];
  isLoading: boolean;
  error: Error | null;
}

/** Children per request; covers typical fan-outs in one read and still follows ``after``. */
const CHILD_PAGE_LIMIT = 200;

/**
 * Fetch child sessions for a parent session.
 *
 * Exported for unit testing of the HTTP-shape contract; production
 * code should call ``useChildSessions``.
 */
export async function fetchChildSessions(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ChildSessionInfo[]> {
  const rows: ChildSessionWire[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const params = new URLSearchParams({ limit: String(CHILD_PAGE_LIMIT) });
    if (after) params.set("after", after);
    // eslint-disable-next-line no-await-in-loop -- Each cursor comes from the preceding page.
    const res = await authenticatedFetch(
      `/v1/sessions/${encodeURIComponent(sessionId)}/child_sessions?${params}`,
      { signal },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    // eslint-disable-next-line no-await-in-loop -- Read this page before choosing the next cursor.
    const page = (await res.json()) as ChildSessionsResponse;
    rows.push(...page.data);
    if (!page.has_more) break;
    if (!page.last_id || cursors.has(page.last_id))
      throw new Error("Child session history returned an invalid cursor.");
    after = page.last_id;
    cursors.add(after);
  } while (after);
  // Children run on this session's runner: record the link so their
  // session-scoped requests key by this session's host before their own
  // snapshot loads.
  for (const row of rows) setSessionParent(row.id, sessionId);
  return rows.map((row) => ({
    created_at: row.created_at,
    updated_at: row.updated_at,
    agent_name: row.agent_name,
    id: row.id,
    title: row.title,
    task_summary: row.task_summary ?? null,
    tool: row.tool,
    session_name: row.session_name,
    labels: row.labels ?? {},
    current_task_status: row.current_task_status,
    last_task_error: parseChildSessionError(row.last_task_error),
    busy: row.busy,
    last_message_preview: row.last_message_preview ?? null,
    pending_elicitations_count: row.pending_elicitations_count ?? 0,
    routed_model: row.routed_model ?? null,
    child_count: typeof row.child_count === "number" ? row.child_count : null,
  }));
}

/** False only for a known leaf; unknown counts still load their list. */
export function mayHaveChildren(child: ChildSessionInfo): boolean {
  return child.child_count !== 0;
}

function childListOptions(parentId: string | null, enabled: boolean) {
  const queryKey = ["conversation", parentId, "child_sessions"];
  return queryOptions({
    queryKey,
    enabled: enabled && !!parentId,
    staleTime: 60_000,
    retry: false,
    refetchOnMount: false,
    queryFn: async ({ client, signal }) => {
      const baseline = client.getQueryData<ChildSessionInfo[]>(queryKey);
      const rows = await fetchChildSessions(
        parentId!,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      );
      const current = client.getQueryData<ChildSessionInfo[]>(queryKey);
      if (!current) return rows;
      // A live update may arrive while a paginated snapshot is in flight.
      const before = new Map(baseline?.map((child) => [child.id, child]));
      const latest = new Map(current.map((child) => [child.id, child]));
      const merged = rows.map((row) => {
        const cached = latest.get(row.id);
        latest.delete(row.id);
        return cached &&
          (cached !== before.get(row.id) ||
            (cached.updated_at !== undefined &&
              row.updated_at !== undefined &&
              cached.updated_at > row.updated_at))
          ? cached
          : row;
      });
      return merged.concat([...latest.values()].filter((child) => child !== before.get(child.id)));
    },
  });
}

function needsRefresh(child: ChildSessionInfo) {
  return (
    child.busy ||
    child.pending_elicitations_count > 0 ||
    ["launching", "running", "in_progress", "queued"].includes(child.current_task_status ?? "") ||
    child.last_task_error?.code === "runner_disconnected"
  );
}

/**
 * Session-list fields an updates frame carries for a child row.
 *
 * The frame lacks the child-list preview, task summary and error, so a
 * running child that settles still needs one list refetch.
 */
export interface ChildFrameRow {
  id: string;
  parent_session_id?: string | null;
  status?: string | null;
  updated_at?: number | null;
  pending_elicitations_count?: number | null;
  child_count?: number | null;
}

/** Overlay one frame row; ``settled`` marks a running child the frame reports finished. */
function patchChildFromFrame(
  child: ChildSessionInfo,
  row: ChildFrameRow,
): { child: ChildSessionInfo; settled: boolean } {
  const frameUpdatedAt = typeof row.updated_at === "number" ? row.updated_at : undefined;
  // A row older than the cached one (for example a transcript delta) must not roll it back.
  if (
    frameUpdatedAt !== undefined &&
    child.updated_at !== undefined &&
    frameUpdatedAt < child.updated_at
  )
    return { child, settled: false };
  const patch: Partial<ChildSessionInfo> = {};
  if (frameUpdatedAt !== undefined && frameUpdatedAt !== child.updated_at)
    patch.updated_at = frameUpdatedAt;
  if (
    typeof row.pending_elicitations_count === "number" &&
    row.pending_elicitations_count !== child.pending_elicitations_count
  )
    patch.pending_elicitations_count = row.pending_elicitations_count;
  if (row.child_count !== undefined) {
    const count = typeof row.child_count === "number" ? row.child_count : null;
    if (count !== (child.child_count ?? null)) patch.child_count = count;
  }
  // The server derives busy and task status from the same session status.
  let settled = false;
  if (row.status === "running" || row.status === "waiting") {
    if (!child.busy) patch.busy = true;
    if (child.current_task_status !== "in_progress") patch.current_task_status = "in_progress";
  } else if ((row.status === "idle" || row.status === "failed") && isChildRunning(child)) {
    patch.busy = false;
    patch.current_task_status = row.status === "failed" ? "failed" : "completed";
    settled = true;
  }
  return Object.keys(patch).length
    ? { child: { ...child, ...patch }, settled }
    : { child, settled };
}

function isChildRunning(child: ChildSessionInfo) {
  return (
    child.busy || ["running", "in_progress", "queued"].includes(child.current_task_status ?? "")
  );
}

/**
 * Patch cached child lists from session-updates frame rows.
 *
 * Status, attention counts and child counts come straight from the frame.
 * Uncached parents are skipped; their list loads fresh when a view shows it.
 *
 * @param client - The app QueryClient holding child-session caches.
 * @param rows - Frame rows; rows without ``parent_session_id`` are ignored.
 * @returns Parent ids that need one coalesced refetch: the frame revealed an
 *   unknown child, or a running child settled without its final preview.
 */
export function applyChildFrameRows(client: QueryClient, rows: readonly ChildFrameRow[]): string[] {
  const rowsByParent = new Map<string, Map<string, ChildFrameRow>>();
  for (const row of rows) {
    if (!row.parent_session_id) continue;
    const siblings = rowsByParent.get(row.parent_session_id) ?? new Map<string, ChildFrameRow>();
    siblings.set(row.id, row);
    rowsByParent.set(row.parent_session_id, siblings);
  }
  const refetchParents: string[] = [];
  for (const [parentId, siblings] of rowsByParent) {
    const key = childSessionsQueryKey(parentId);
    const cached = client.getQueryData<ChildSessionInfo[]>(key);
    if (!cached) continue;
    let refetch = false;
    let changed = false;
    const next = cached.map((child) => {
      const row = siblings.get(child.id);
      if (!row) return child;
      siblings.delete(child.id);
      const patched = patchChildFromFrame(child, row);
      refetch ||= patched.settled;
      changed ||= patched.child !== child;
      return patched.child;
    });
    if (changed) client.setQueryData(key, next);
    if (refetch || siblings.size > 0) refetchParents.push(parentId);
  }
  return refetchParents;
}

/** Minimum spacing between pushed refetches of one parent's child list. */
export const CHILD_LIST_REFETCH_MS = 5_000;

const refetchSchedules = new WeakMap<
  QueryClient,
  Map<string, { lastAt: number; timer?: ReturnType<typeof setTimeout> }>
>();

/**
 * Refetch a parent's child list at most once per {@link CHILD_LIST_REFETCH_MS}.
 *
 * The first request runs at once; requests inside the window fold into one
 * trailing refetch. A refetch never aborts a read already in flight; it waits
 * for that read to settle, because the read may predate the change.
 *
 * @param client - The app QueryClient holding child-session caches.
 * @param parentId - Parent whose list changed, e.g. ``"conv_root"``.
 */
export function scheduleChildListRefetch(client: QueryClient, parentId: string): void {
  let schedules = refetchSchedules.get(client);
  if (!schedules) refetchSchedules.set(client, (schedules = new Map()));
  const schedule = schedules.get(parentId) ?? { lastAt: Number.NEGATIVE_INFINITY };
  schedules.set(parentId, schedule);
  if (schedule.timer !== undefined) return;
  const key = childSessionsQueryKey(parentId);
  const run = () => {
    schedule.timer = undefined;
    if (client.getQueryState(key)?.fetchStatus === "fetching") {
      schedule.timer = setTimeout(run, CHILD_LIST_REFETCH_MS);
      return;
    }
    schedule.lastAt = Date.now();
    void client.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
  };
  const wait = schedule.lastAt + CHILD_LIST_REFETCH_MS - Date.now();
  if (wait <= 0) run();
  else schedule.timer = setTimeout(run, wait);
}

function availableRows(rows: ChildSessionInfo[] = [], unavailable: boolean) {
  return unavailable
    ? rows.map((child) => (needsRefresh(child) ? { ...child, statusUnavailable: true } : child))
    : rows;
}

// Cards, shelf and Orchestration share one clock and one in-flight query per visible root list.
const refreshClocks = new WeakMap<QueryClient, Map<string, { leases: number; timer: number }>>();

function watchParent(client: QueryClient, parentId: string) {
  let clocks = refreshClocks.get(client);
  if (!clocks) refreshClocks.set(client, (clocks = new Map()));
  let clock = clocks.get(parentId);
  if (!clock) {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void client.refetchQueries(
        { queryKey: childSessionsQueryKey(parentId), exact: true, type: "active" },
        { cancelRefetch: false },
      );
    }, 5_000);
    clocks.set(parentId, (clock = { leases: 0, timer }));
  }
  clock.leases++;
  return () => {
    if (--clock.leases > 0) return;
    window.clearInterval(clock.timer);
    clocks.delete(parentId);
    const key = childSessionsQueryKey(parentId);
    const query = client.getQueryCache().find({ queryKey: key, exact: true });
    if (query && !query.isActive() && query.state.fetchStatus === "fetching") {
      void client.cancelQueries({ queryKey: key, exact: true });
    }
  };
}

/** Observe the parent's cache; a visible root list with active or unresolved children refreshes every five seconds. */
export function useChildSessions(
  conversationId: string | null,
  options: {
    enabled?: boolean;
    reconcile?: boolean;
    unresolvedChild?: string;
    dispatchId?: string;
  } = {},
): UseChildSessionsResult {
  const client = useQueryClient();
  const parentId = isTempConvId(conversationId) ? null : conversationId;
  const enabled = options.enabled !== false && !!parentId;
  const query = useQuery(childListOptions(parentId, enabled));
  const previousDispatch = useRef(options.dispatchId);
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    const newDispatch = previousDispatch.current !== options.dispatchId;
    previousDispatch.current = options.dispatchId;
    if (enabled && (!wasEnabled.current || newDispatch)) {
      void client.refetchQueries(
        { queryKey: childSessionsQueryKey(parentId!), exact: true },
        { cancelRefetch: false },
      );
    }
    wasEnabled.current = enabled;
  }, [client, enabled, parentId, options.dispatchId]);
  const unresolved =
    options.unresolvedChild &&
    !query.data?.some(
      (child) =>
        child.id === options.unresolvedChild &&
        (child.current_task_status || child.last_task_error),
    );
  const reconcile = enabled && options.reconcile && (unresolved || query.data?.some(needsRefresh));
  useEffect(
    () => (reconcile && parentId ? watchParent(client, parentId) : undefined),
    [client, parentId, reconcile],
  );
  return {
    children: availableRows(query.data, query.isError || query.isPaused),
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** Nested lists load only for possible parents and refresh through pushes, not the root clock. */
function useChildLevel(parents: ChildSessionInfo[], enabled: boolean) {
  return useQueries({
    queries: parents.filter(mayHaveChildren).map((parent) => childListOptions(parent.id, enabled)),
  });
}

/** Flat projection of the existing three-level tree; hidden views retain cached rows. */
export function useChildSessionTree(rootId: string, enabled: boolean): UseChildSessionsResult {
  const root = useChildSessions(rootId, { enabled, reconcile: true });
  const second = useChildLevel(root.children, enabled);
  const grandchildren = second.flatMap((query) =>
    availableRows(query.data, query.isError || query.isPaused),
  );
  const third = useChildLevel(grandchildren, enabled);
  const queries = [...second, ...third];
  const children = [
    ...root.children,
    ...grandchildren,
    ...third.flatMap((q) => availableRows(q.data, q.isError || q.isPaused)),
  ];
  return {
    children: [
      ...new Map(
        children.filter((child) => child.id !== rootId).map((child) => [child.id, child]),
      ).values(),
    ],
    isLoading: root.isLoading || queries.some((query) => query.isLoading),
    error: root.error ?? queries.find((query) => query.error)?.error ?? null,
  };
}

/**
 * Summary of ``targetId`` as listed under ``ancestorId``'s spawn tree.
 *
 * Direct children come from ``useChildSessions`` (fetched when not yet
 * cached); deeper descendants are read from lists the Agents rail has
 * cached. Re-renders when any cached child-session list changes.
 *
 * @param ancestorId - Session whose tree to search, e.g. ``"conv_root"``;
 *   ``null`` disables the lookup.
 * @param targetId - Descendant to find, e.g. ``"conv_child123"``.
 * @returns The descendant's summary, or ``null`` while unknown.
 */
export function useDescendantSession(
  ancestorId: string | null,
  targetId: string,
): ChildSessionInfo | null {
  const queryClient = useQueryClient();
  useChildSessions(ancestorId);
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && isChildSessionsQueryKey(event.query.queryKey)) onChange();
      }),
    [queryClient],
  );
  // Cached rows keep their identity until their list changes, so the
  // snapshot is stable between unrelated cache events.
  return useSyncExternalStore(subscribe, () =>
    ancestorId === null
      ? null
      : findCachedDescendant(queryClient, ancestorId, targetId, MAX_TREE_DEPTH),
  );
}
