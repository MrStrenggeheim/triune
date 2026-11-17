// Modified for Triune.
import { createContext, useContext } from "react";
import { useResourceViewState } from "./panelFolder";
import type { RenderItem } from "./renderItems";
import type { AnyBlock } from "./blocks";
import {
  readResourceViewState,
  resourceViewStorageScope,
  writeResourceViewState,
} from "./resourceViewStorage";

export { resourceViewStorageScope as transcriptReaderScope } from "./resourceViewStorage";

export type TranscriptViewSnapshot =
  | { atBottom: true }
  | {
      atBottom: false;
      anchorKey: string | null;
      anchorItemId?: string | null;
      anchorOffset: number;
      fallbackOffset: number;
    };

type DisclosureChoices = Record<string, { open: boolean; revealRequest?: string }>;

/** Only identities and UI choices live here; never blocks, Files or source text. */
export interface TranscriptReaderCheckpoint {
  snapshot?: TranscriptViewSnapshot;
  disclosures?: DisclosureChoices;
  loadedMinPosition?: number;
  firstItemId?: string | null;
  expandedHistoryId?: string | null;
  revealedItemIds?: string[];
  originalItemIds?: string[];
  searchTarget?: { itemId: string; start: number; end: number } | null;
}

const keyFor = (id: string, viewId = id) => `transcript-reader:${JSON.stringify([id, viewId])}`;
const latestKeyFor = (id: string) => `transcript-reader-latest:${JSON.stringify(id)}`;
interface LatestReader {
  viewId: string;
  checkpoint: TranscriptReaderCheckpoint;
}

function validSnapshot(snapshot: TranscriptViewSnapshot | undefined): boolean {
  return (
    !!snapshot &&
    (snapshot.atBottom === true ||
      (snapshot.atBottom === false &&
        (snapshot.anchorKey === null || typeof snapshot.anchorKey === "string") &&
        Number.isFinite(snapshot.anchorOffset) &&
        Number.isFinite(snapshot.fallbackOffset) &&
        snapshot.fallbackOffset >= 0))
  );
}

function writeCheckpoint(key: string, value: unknown): void {
  if (JSON.stringify(readResourceViewState(key)) !== JSON.stringify(value))
    writeResourceViewState(key, value);
}

export function readTranscriptReaderCheckpoint(
  id: string,
  viewId = id,
  scope = resourceViewStorageScope(),
): TranscriptReaderCheckpoint | undefined {
  if (scope !== resourceViewStorageScope()) return;
  const saved = readResourceViewState<TranscriptReaderCheckpoint>(keyFor(id, viewId));
  const latest = readResourceViewState<LatestReader>(latestKeyFor(id));
  const { snapshot, ...metadata } = saved ?? {};
  const reader = validSnapshot(snapshot)
    ? saved
    : validSnapshot(latest?.checkpoint?.snapshot)
      ? { ...latest!.checkpoint, ...metadata }
      : saved;
  const range = readResourceViewState<TranscriptReaderCheckpoint>(keyFor(id));
  return reader || range
    ? {
        ...reader,
        loadedMinPosition: range?.loadedMinPosition ?? reader?.loadedMinPosition,
        firstItemId:
          range?.loadedMinPosition !== undefined ? range.firstItemId : reader?.firstItemId,
      }
    : undefined;
}

export function rememberTranscriptReaderCheckpoint(
  id: string,
  patch: Partial<TranscriptReaderCheckpoint>,
  viewId = id,
  scope = resourceViewStorageScope(),
  promoteSnapshot = true,
): void {
  if (scope !== resourceViewStorageScope()) return;
  // A newly mounted view forks the fallback once; later views never move its anchor.
  const previous = readTranscriptReaderCheckpoint(id, viewId, scope);
  const next = { ...previous, ...patch };
  writeCheckpoint(keyFor(id, viewId), next);
  const latest = readResourceViewState<LatestReader>(latestKeyFor(id));
  if (
    validSnapshot(next.snapshot) &&
    ((promoteSnapshot && validSnapshot(patch.snapshot)) || latest?.viewId === viewId)
  )
    writeCheckpoint(latestKeyFor(id), { viewId, checkpoint: next });
}

/** Client calls this with canonical window metadata, including hidden first items. */
export function recordTranscriptLoadedRange(
  id: string,
  loadedMinPosition: number,
  firstItemId: string | null,
  scope = resourceViewStorageScope(),
): void {
  if (!Number.isSafeInteger(loadedMinPosition) || loadedMinPosition < 0) return;
  const previous = readTranscriptReaderCheckpoint(id, id, scope);
  if (previous?.loadedMinPosition !== undefined && previous.loadedMinPosition < loadedMinPosition)
    return;
  if (scope !== resourceViewStorageScope()) return;
  // Canonical range refreshes never select a different reader as the conversation fallback.
  writeCheckpoint(keyFor(id), {
    ...readResourceViewState<TranscriptReaderCheckpoint>(keyFor(id)),
    loadedMinPosition,
    firstItemId,
  });
}

/** Fallback for legacy hydration; negotiated clients also record hidden membership. */
export function checkpointTranscriptBlocks(id: string, blocks: readonly AnyBlock[]): void {
  let first: AnyBlock | undefined;
  for (const block of blocks) {
    if (
      block.ctx.itemId &&
      !block.ctx.itemId.startsWith("live:") &&
      block.ctx.position !== undefined &&
      (!first || block.ctx.position < first.ctx.position!)
    )
      first = block;
  }
  if (first) recordTranscriptLoadedRange(id, first.ctx.position!, first.ctx.itemId);
}

export interface TranscriptReaderRestoreRequest {
  conversationId: string;
  checkpoint: TranscriptReaderCheckpoint;
  /** Cancels this view's alignment request, never the server's agent work. */
  signal: AbortSignal;
}
export type TranscriptReaderHydrator = (
  request: TranscriptReaderRestoreRequest,
) => Promise<boolean>;
let hydrator: { run: TranscriptReaderHydrator } | undefined;

/** Parent/client installs paging + exact reveal; cleanup cannot remove a newer handler. */
export function setTranscriptReaderHydrator(next: TranscriptReaderHydrator): () => void {
  const installed = { run: next };
  hydrator = installed;
  return () => {
    if (hydrator === installed) hydrator = undefined;
  };
}

export async function restoreTranscriptReaderCheckpoint(
  conversationId: string,
  checkpoint: TranscriptReaderCheckpoint,
  signal: AbortSignal,
  scope = resourceViewStorageScope(),
): Promise<boolean> {
  if (signal.aborted || scope !== resourceViewStorageScope()) return false;
  // Legacy full-history clients need no extra hydration. Bounded clients install the seam.
  const handler = hydrator;
  if (!handler) return true;
  return new Promise<boolean>((resolve, reject) => {
    const cancel = () => resolve(false);
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve()
      .then(() => (signal.aborted ? false : handler.run({ conversationId, checkpoint, signal })))
      .then(
        (restored) =>
          resolve(
            restored &&
              !signal.aborted &&
              handler === hydrator &&
              scope === resourceViewStorageScope(),
          ),
        (error) =>
          signal.aborted || scope !== resourceViewStorageScope() ? resolve(false) : reject(error),
      )
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Shared disclosure state uses the existing account/server/view storage owner. */
export const TranscriptReaderContext = createContext<{
  conversationId: string | null;
  viewId?: string;
  scope: string;
} | null>(null);

export function useTranscriptDisclosureState(key: string | undefined, revealRequest?: string) {
  const owner = useContext(TranscriptReaderContext);
  const inherited = owner?.conversationId
    ? readTranscriptReaderCheckpoint(owner.conversationId, owner.viewId, owner.scope)?.disclosures
    : undefined;
  const [choices, setChoices] = useResourceViewState<DisclosureChoices | undefined>(
    owner?.conversationId ?? undefined,
    owner?.viewId,
    "transcript-disclosures",
    undefined,
  );
  const choice = key ? (choices ?? inherited)?.[key] : undefined;
  const newerRequest = revealRequest !== undefined && revealRequest !== choice?.revealRequest;
  const setOpen = (open: boolean) => {
    if (!key || (owner && owner.scope !== resourceViewStorageScope())) return;
    setChoices((previous) => {
      const next = { ...(previous ?? inherited), [key]: { open, revealRequest } };
      if (owner?.conversationId)
        rememberTranscriptReaderCheckpoint(
          owner.conversationId,
          { disclosures: next },
          owner.viewId,
          owner.scope,
          false,
        );
      return next;
    });
  };
  return [newerRequest ? undefined : choice?.open, setOpen] as const;
}

/** Response-scoped calls keep their presentation identity through item promotion. */
export function transcriptDisclosureItemKey(item: RenderItem | undefined): string | undefined {
  if (!item) return;
  if (item.kind === "tool") {
    if (item.responseId)
      return `tool-call:${JSON.stringify([item.responseId, item.execution.callId])}`;
    return `tool:${JSON.stringify([item.itemId, item.execution.callId])}`;
  }
  if (item.itemId) return `${item.kind}:${item.itemId}`;
  return undefined;
}
