// Modified for Triune.
import { LIVE_ITEM_PREFIX } from "@/lib/blocks";
import { forkSession, getSessionSlim, launchRunner } from "@/lib/sessionsApi";
import { nativeCodingAgentForSession } from "@/lib/nativeCodingAgents";
import { setSessionDraft, type SessionDraft } from "@/lib/sessionDrafts";
import { readReferenceDraft, writeReferenceDraft } from "@/lib/contextReferenceDrafts";
import type { WorkbenchActions } from "./WorkbenchContext";

const pendingSources = new Set<string>();
const recoverableChildren = new Map<
  string,
  { id: string; prepared?: boolean; initialize: () => Promise<void> }
>();
const pendingChildren = new Map<string, Promise<string>>();

/** Bind a durable fork through the same host launch API as the ordinary Clone dialog. */
export function createDurableSubchat(
  sourceId: string,
  boundaryId: string | undefined,
  retryKey: string,
  onCreated?: (id: string) => void | Promise<void>,
): Promise<string> {
  const pending = pendingChildren.get(retryKey);
  if (pending) return pending;
  const task = (async () => {
    let child = recoverableChildren.get(retryKey);
    if (!child) {
      const source = await getSessionSlim(sourceId);
      const needsHost = !!(
        source.workspace ||
        source.hostId ||
        nativeCodingAgentForSession(source)
      );
      if (needsHost && (!source.hostId || !source.workspace)) {
        throw new Error(
          "Reconnect the source conversation to a host and directory, then retry the subchat.",
        );
      }
      const session = await forkSession(sourceId, {
        title: "Subchat",
        ...(boundaryId ? { upToItemId: boundaryId } : {}),
      });
      let attempted = false;
      child = {
        id: session.id,
        initialize: async () => {
          if (!needsHost) return;
          if (attempted) {
            // A dropped launch response may already have bound this child.
            const current = await getSessionSlim(session.id);
            if (current.runnerId && current.workspace) return;
          }
          attempted = true;
          await launchRunner(source.hostId!, session.id, source.workspace!);
        },
      };
      recoverableChildren.set(retryKey, child);
    }
    if (!child.prepared) {
      await onCreated?.(child.id);
      child.prepared = true;
    }
    try {
      await child.initialize();
    } catch (failure) {
      throw new Error(
        `Subchat ${child.id} could not connect: ${failure instanceof Error ? failure.message : String(failure)}. Retry to reconnect this same subchat.`,
        { cause: failure },
      );
    }
    recoverableChildren.delete(retryKey);
    return child.id;
  })();
  pendingChildren.set(retryKey, task);
  void task.then(
    () => pendingChildren.delete(retryKey),
    () => pendingChildren.delete(retryKey),
  );
  return task;
}

/** Ignore ephemeral stream chunks and delegated blocks when capturing the visible boundary. */
export function subchatBoundary(
  blocks: readonly { ctx: { itemId: string | null; depth: number } }[],
) {
  return (
    blocks.findLast((block) => {
      const id = block.ctx.itemId;
      return (
        block.ctx.depth === 0 &&
        !!id &&
        ![LIVE_ITEM_PREFIX, "pending:", "temp:"].some((prefix) => id.startsWith(prefix)) &&
        !id.endsWith(":user") &&
        !id.endsWith(":answer")
      );
    })?.ctx.itemId ?? undefined
  );
}

/** Fork immediately; seed an ordinary unsent draft before opening its conversation view. */
export function openDurableSubchat({
  sourceId,
  boundaryId,
  draft,
  openConversation,
}: {
  sourceId: string;
  boundaryId?: string;
  draft: SessionDraft;
  openConversation: WorkbenchActions["openConversation"];
}): Promise<string> | null {
  if (pendingSources.has(sourceId)) return null;
  const snapshot: SessionDraft = {
    text: draft.text,
    files: [...draft.files],
    ...(draft.replyDraft
      ? {
          replyDraft: {
            ...draft.replyDraft,
            quotes: draft.replyDraft.quotes.map((quote) => ({ ...quote })),
          },
        }
      : {}),
  };
  const references = readReferenceDraft(sourceId);
  pendingSources.add(sourceId);
  const task = (async () => {
    const id = await createDurableSubchat(
      sourceId,
      boundaryId,
      `composer:${sourceId}`,
      (childId) => {
        setSessionDraft(childId, snapshot);
        if (references.length) writeReferenceDraft(childId, references);
      },
    );
    openConversation(id, { beside: true });
    return id;
  })();
  void task.then(
    () => pendingSources.delete(sourceId),
    () => pendingSources.delete(sourceId),
  );
  return task;
}
