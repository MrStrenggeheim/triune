// Modified for Triune.
import type { QueryClient } from "@tanstack/react-query";
import { toast, updateNotification, hideNotification } from "@/lib/notifications";

import type { useNavigate } from "@/lib/routing";
import { undoArchiveConversations, type Conversation } from "@/hooks/useConversations";
import { conversationDisplayLabel } from "./sidebarNav";

type NavigateFn = ReturnType<typeof useNavigate>;

/**
 * How long the post-archive Undo pill stays on screen, in milliseconds. 3s
 * reads as long enough to catch and act on without lingering.
 */
const ARCHIVE_UNDO_DURATION_MS = 3000;

/**
 * Absolute cap on the merged pill's total on-screen life, measured from the
 * FIRST archive in the batch. Merges shorten the remaining countdown toward
 * this cap rather than resetting a fresh 3s each time, so the pill can't outlive
 * the server's per-session teardown grace (`_ARCHIVE_STOP_UNDO_GRACE_S`, 8s).
 * If it could, the earliest-archived session's runner would be stopped at the
 * grace while the pill still offered Undo — undoing then would restore a row
 * over a dead pane. Kept below the grace with margin for the unarchive round
 * trip. MUST stay < that grace.
 */
const ARCHIVE_UNDO_MAX_LIFETIME_MS = 5000;

// A batch shares one popup; later batches get separate history entries.
let batchSequence = 0;
let activeToastId: string | null = null;
let batchDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

// Archive entry points merge one visible batch; each retained notification owns its captured rows for later restore.
let batched: Conversation[] = [];
// When the current batch's pill first appeared (epoch ms), or null if none.
let batchStartedAtMs: number | null = null;
// The most recent caller's QueryClient. Every entry point resolves the same
// app-level client, so the latest one correctly unarchives the whole batch.
let activeQueryClient: QueryClient | null = null;
let activeNavigate: NavigateFn | null = null;

function clearBatch(): void {
  if (batchDeadlineTimer !== null) clearTimeout(batchDeadlineTimer);
  batchDeadlineTimer = null;
  batched = [];
  batchStartedAtMs = null;
  activeQueryClient = null;
  activeNavigate = null;
  activeToastId = null;
}

/**
 * Show (or extend) the post-archive Undo pill after archiving `conversations`.
 *
 * Fire it right after kicking off the archive — like the old Settings toast, it
 * runs synchronously on the click because the archiving row unmounts on the
 * next frame (optimistic overlay). Repeated calls merge their rows into the
 * same pill, so undoing restores every session archived since the pill first
 * appeared. A failed archive reconciles its own row back and the extra row in
 * the batch is harmless — unarchiving a session that never archived is a no-op.
 *
 * A merge does NOT reset a fresh countdown: the batch has an ABSOLUTE deadline
 * (`ARCHIVE_UNDO_MAX_LIFETIME_MS` from the first archive), and a merge only
 * shortens the remaining time toward it. So the pill can't outlive the
 * earliest-archived session's server teardown grace and offer an Undo for a
 * runner already stopped. An archive arriving after the deadline starts a FRESH
 * batch rather than extending the expiring one.
 */
export function showArchiveUndoToast(
  queryClient: QueryClient,
  conversations: readonly Conversation[],
  navigate: NavigateFn,
): void {
  if (conversations.length === 0) return;
  const now = Date.now();
  // Start (or restart) the batch when there is none, or when the current one
  // has hit its absolute deadline — a late archive must not join a batch whose
  // pill is expiring, or it would extend an Undo past the server grace.
  if (batchStartedAtMs === null || now - batchStartedAtMs >= ARCHIVE_UNDO_MAX_LIFETIME_MS) {
    batched = [];
    batchStartedAtMs = now;
    activeToastId = `archive-undo:${++batchSequence}`;
    const expires = activeToastId;
    if (batchDeadlineTimer !== null) clearTimeout(batchDeadlineTimer);
    batchDeadlineTimer = setTimeout(() => hideNotification(expires), ARCHIVE_UNDO_MAX_LIFETIME_MS);
  }
  activeQueryClient = queryClient;
  activeNavigate = navigate;
  const seen = new Set(batched.map((c) => c.id));
  for (const conv of conversations) {
    if (!seen.has(conv.id)) {
      batched.push(conv);
      seen.add(conv.id);
    }
  }
  // Time left until the batch's absolute deadline; capped at the normal
  // single-archive duration so one archive still gets the full pill. A merge
  // shortens this toward the deadline and never adds to it.
  const remaining = Math.min(
    ARCHIVE_UNDO_DURATION_MS,
    batchStartedAtMs + ARCHIVE_UNDO_MAX_LIFETIME_MS - now,
  );
  const count = batched.length;
  const id = activeToastId!;
  const members = [...batched];
  const client = activeQueryClient!;
  const navigateTo = activeNavigate!;
  const clearActiveBatch = () => {
    if (activeToastId === id) clearBatch();
  };
  const restore = () => {
    clearActiveBatch();
    toast.dismiss(id);
    return undoArchiveConversations(client, members);
  };
  const view = () => {
    clearActiveBatch();
    toast.dismiss(id);
    navigateTo("/settings/archived");
  };
  const names = members.slice(0, 2).map(conversationDisplayLabel);
  const title = count === 1 ? `Archived “${names[0]}”` : `Archived ${count} chats`;
  const summary =
    count === 1
      ? undefined
      : `${names.map((name) => `“${name}”`).join(", ")}${count > 2 ? ` and ${count - 2} more` : ""}`;
  toast(title, {
    id,
    description: summary,
    duration: remaining,
    action: { label: "Undo", onClick: restore },
    cancel: { label: "View archived", onClick: view },
    testId: "archive-undo-toast-item",
    onAutoClose: () => {
      clearActiveBatch();
      // The brief Undo window protects a live runner; history offers an explicit restore afterward.
      updateNotification(id, {
        description: summary
          ? `${summary}. Restore these chats to the sidebar.`
          : "Restore this chat to the sidebar.",
        action: { label: "Restore", onClick: restore },
      });
    },
    onDismiss: clearActiveBatch,
  });
}

/** Test-only: drop the pending Undo batch so cases don't leak module state. */
export function resetArchiveUndoBatchForTests(): void {
  clearBatch();
}
