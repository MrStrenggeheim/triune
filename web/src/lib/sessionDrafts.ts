// Modified for Triune.
import type { MentionItem } from "./composerMentions";
import { readComposerDrafts, writeComposerDrafts } from "./queuedMessagePersistence";
import { clearReferenceDrafts } from "./contextReferenceDrafts";
import { useSyncExternalStore } from "react";
import { readComposerDraft, type ComposerDraft } from "./replyDraft";

export interface SessionDraft extends ComposerDraft {
  files: File[];
  /** Captured path chips and structured reference snapshots, in display order. */
  mentionedItems?: MentionItem[];
}

const SESSION_DRAFTS_KEY = "omnigent.sessionDrafts";
const listeners = new Set<() => void>();
const retiredDraftIds = new Set<string>();

function loadDraftsFromStorage(): Map<string, SessionDraft> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.sessionStorage.getItem(SESSION_DRAFTS_KEY);
    if (!raw) return new Map();
    const entries: unknown = JSON.parse(raw);
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return new Map();
    const drafts = new Map<string, SessionDraft>();
    for (const [id, entry] of Object.entries(entries)) {
      const draft = readComposerDraft(entry);
      if (draft?.text) drafts.set(id, { ...draft, files: [] });
    }
    return drafts;
  } catch {
    return new Map();
  }
}

function saveDraftsToStorage(): void {
  persistSnapshot();
  if (typeof window === "undefined") return;
  try {
    const entries: Record<string, string | ComposerDraft> = {};
    for (const [id, draft] of sessionDrafts) {
      if (draft.text)
        entries[id] = draft.replyDraft
          ? { text: draft.text, replyDraft: draft.replyDraft }
          : draft.text;
    }
    if (Object.keys(entries).length === 0) {
      window.sessionStorage.removeItem(SESSION_DRAFTS_KEY);
    } else {
      window.sessionStorage.setItem(SESSION_DRAFTS_KEY, JSON.stringify(entries));
    }
  } catch (error) {
    persistenceError = error;
    reportPersistenceError?.(error);
  }
}

const sessionDrafts = loadDraftsFromStorage();
let activeScope: string | null = null;
let generation = 0;
let writes = Promise.resolve();
let hydration = Promise.resolve();
let persistenceError: unknown;
let reportPersistenceError: ((error: unknown) => void) | undefined;
const editedDuringHydration = new Set<string>();
const pendingPromotions = new Map<string, string>();
let loading = false;
let clearedDuringHydration = false;

function persistSnapshot(): void {
  if (!activeScope || loading) return;
  const owner = activeScope;
  const snapshot = new Map(sessionDrafts);
  const revision = generation;
  writes = writes
    .then(() => writeComposerDrafts(owner, snapshot))
    .then(() => {
      if (revision === generation) persistenceError = undefined;
    })
    .catch((error) => {
      if (revision !== generation) return;
      persistenceError = error;
      reportPersistenceError?.(error);
    });
}

/** Install at app boot and refresh on server/account changes. */
export function initializeSessionDraftPersistence(
  scope: string | null,
  reportError?: (error: unknown) => void,
): void {
  reportPersistenceError = reportError;
  if (scope === activeScope) return;
  const previous = activeScope;
  activeScope = scope;
  const revision = ++generation;
  persistenceError = undefined;
  editedDuringHydration.clear();
  pendingPromotions.clear();
  clearedDuringHydration = false;
  retiredDraftIds.clear();
  // Legacy sessionStorage belongs to this tab's first identity only.
  let legacyOwner: string | null = null;
  try {
    legacyOwner =
      typeof sessionStorage === "undefined"
        ? null
        : sessionStorage.getItem(`${SESSION_DRAFTS_KEY}.scope`);
  } catch (error) {
    reportPersistenceError?.(error);
  }
  const changedIdentity = previous !== null || !!(legacyOwner && legacyOwner !== scope);
  if (changedIdentity) sessionDrafts.clear();
  try {
    if (changedIdentity) {
      clearReferenceDrafts();
      sessionStorage.removeItem(SESSION_DRAFTS_KEY);
    }
    if (typeof sessionStorage !== "undefined") {
      if (scope) sessionStorage.setItem(`${SESSION_DRAFTS_KEY}.scope`, scope);
      else sessionStorage.removeItem(SESSION_DRAFTS_KEY);
    }
  } catch (error) {
    reportPersistenceError?.(error);
  }
  notifyListeners();
  if (!scope) {
    loading = false;
    return;
  }
  loading = true;
  hydration = writes
    .then(() => readComposerDrafts(scope))
    .then((saved) => {
      if (revision !== generation) return;
      for (const [id, draft] of saved) {
        if (clearedDuringHydration) continue;
        const promotedId = pendingPromotions.get(id);
        if (promotedId) {
          if (!editedDuringHydration.has(promotedId) && !retiredDraftIds.has(promotedId))
            sessionDrafts.set(promotedId, draft);
        } else if (!editedDuringHydration.has(id) && !retiredDraftIds.has(id)) {
          sessionDrafts.set(id, draft);
        }
      }
      pendingPromotions.clear();
      loading = false;
      persistSnapshot();
      notifyListeners();
    })
    .catch((error) => {
      if (revision !== generation) return;
      loading = false;
      persistenceError = error;
      reportPersistenceError?.(error);
    });
}

/** Await full attachment hydration; callers must also check their local edit generation. */
export async function hydrateSessionDraft(
  conversationId: string,
): Promise<SessionDraft | undefined> {
  const revision = generation;
  await hydration;
  return revision === generation ? getSessionDraft(conversationId) : undefined;
}

/** Resolve only after the whole snapshot is durable, or reject with the visible storage error. */
export async function waitForSessionDraftSave(): Promise<void> {
  await hydration;
  await writes;
  if (persistenceError)
    throw persistenceError instanceof Error
      ? persistenceError
      : new Error(String(persistenceError));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function getSessionDraft(conversationId: string): SessionDraft | undefined {
  return sessionDrafts.get(conversationId);
}

export function setSessionDraft(conversationId: string, draft: SessionDraft): void {
  if (retiredDraftIds.has(conversationId)) return;
  editedDuringHydration.add(conversationId);
  if (draft.text === "" && draft.files.length === 0 && !draft.mentionedItems?.length) {
    sessionDrafts.delete(conversationId);
  } else {
    sessionDrafts.set(conversationId, draft);
  }
  saveDraftsToStorage();
  notifyListeners();
}

/** Remove a draft and ignore any late cleanup write for the retired id. */
export function retireSessionDraft(conversationId: string): SessionDraft | undefined {
  const draft = sessionDrafts.get(conversationId);
  retiredDraftIds.add(conversationId);
  editedDuringHydration.add(conversationId);
  if (draft === undefined) return undefined;
  sessionDrafts.delete(conversationId);
  saveDraftsToStorage();
  notifyListeners();
  return draft;
}

/** Merge a failed temporary session's unsent input back into its source draft. */
export function recoverFailedSessionDraft<T extends { message: string; files: File[] }>(
  originalDraft: T,
  temporaryConversationId?: string,
): T {
  if (temporaryConversationId === undefined) return originalDraft;
  const temporaryDraft = retireSessionDraft(temporaryConversationId);
  if (temporaryDraft === undefined) return originalDraft;
  const message = [originalDraft.message, temporaryDraft.text]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  return {
    ...originalDraft,
    message,
    files: [...originalDraft.files, ...temporaryDraft.files],
  };
}

/** Move an unsent draft when a temporary conversation receives its real id. */
export function promoteSessionDraft(
  temporaryConversationId: string,
  conversationId: string,
): SessionDraft | undefined {
  const draft = sessionDrafts.get(temporaryConversationId);
  const awaitingSource = loading && !editedDuringHydration.has(temporaryConversationId);
  if (awaitingSource) pendingPromotions.set(temporaryConversationId, conversationId);
  if (draft === undefined && !awaitingSource) return undefined;
  retiredDraftIds.add(temporaryConversationId);
  editedDuringHydration.add(temporaryConversationId);
  sessionDrafts.delete(temporaryConversationId);
  if (draft !== undefined) sessionDrafts.set(conversationId, draft);
  if (!awaitingSource) editedDuringHydration.add(conversationId);
  saveDraftsToStorage();
  notifyListeners();
  return draft;
}

export function hasSessionDraft(conversationId: string): boolean {
  const draft = sessionDrafts.get(conversationId);
  return (
    draft !== undefined &&
    (draft.text.trim() !== "" || draft.files.length > 0 || !!draft.mentionedItems?.length)
  );
}

export function useHasSessionDraft(conversationId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hasSessionDraft(conversationId),
    () => false,
  );
}

const ignoreDrafts = () => () => {};

function draftIdsKey(): string {
  return [...sessionDrafts.keys()].filter(hasSessionDraft).sort().join("\n");
}

/**
 * The ids holding a draft, as one string that changes only when a draft appears
 * or clears — so typing doesn't re-render a subscriber. Disabled: "" and no
 * subscription.
 */
export function useSessionDraftIds(enabled = true): string {
  return useSyncExternalStore(
    enabled ? subscribe : ignoreDrafts,
    enabled ? draftIdsKey : () => "",
    () => "",
  );
}

/** Clear all drafts, primarily for logout/reset flows and isolated tests. */
export function clearSessionDrafts(): void {
  if (loading) clearedDuringHydration = true;
  clearReferenceDrafts();
  for (const id of sessionDrafts.keys()) editedDuringHydration.add(id);
  sessionDrafts.clear();
  retiredDraftIds.clear();
  saveDraftsToStorage();
  notifyListeners();
}
