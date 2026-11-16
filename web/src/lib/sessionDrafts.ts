// Modified for Triune.
import type { MentionItem } from "./composerMentions";
import { readComposerDraftSnapshot, writeComposerDrafts } from "./queuedMessagePersistence";
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
    for (const [id, draft] of active.drafts) {
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
    active.error = error;
    reportPersistenceError?.(error);
  }
}

interface DraftOwner {
  scope: string | null;
  drafts: Map<string, SessionDraft>;
  persisted: Map<string, SessionDraft>;
  retired: Set<string>;
  edited: Set<string>;
  promotions: Map<string, string>;
  loading: boolean;
  hydrated: boolean;
  cleared: boolean;
  version: number;
  error?: unknown;
}

function draftOwner(scope: string | null, drafts = new Map<string, SessionDraft>()): DraftOwner {
  return {
    scope,
    drafts,
    persisted: new Map(),
    retired: new Set(),
    edited: new Set(),
    promotions: new Map(),
    loading: false,
    hydrated: false,
    cleared: false,
    version: 0,
  };
}

const owners = new Map<string, DraftOwner>();
let active = draftOwner(null, loadDraftsFromStorage());
let generation = 0;
let claimedLegacy = false;
let writes = Promise.resolve();
let hydration = Promise.resolve();
let reportPersistenceError: ((error: unknown) => void) | undefined;

function failure(owner: DraftOwner, error: unknown): void {
  owner.error = error;
  if (owner === active) {
    reportPersistenceError?.(error);
    notifyListeners();
  }
}

async function save(
  owner: DraftOwner,
  snapshot: Map<string, SessionDraft>,
  version: number,
): Promise<void> {
  await writeComposerDrafts(owner.scope!, snapshot, owner.persisted);
  owner.persisted = snapshot;
  owner.error = undefined;
  if (version === owner.version) {
    owner.edited.clear();
    owner.cleared = false;
  }
}

function persistSnapshot(): void {
  const owner = active;
  if (!owner.scope || !owner.hydrated) return;
  const snapshot = new Map(owner.drafts);
  const version = owner.version;
  writes = writes
    .then(() => save(owner, snapshot, version))
    .catch((error) => failure(owner, error));
}

/** Install at app boot and refresh on server/account changes. */
export function initializeSessionDraftPersistence(
  scope: string | null,
  reportError?: (error: unknown) => void,
): void {
  reportPersistenceError = reportError;
  if (scope === active.scope) return;
  const previous = active;
  ++generation;
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
  const changedIdentity = claimedLegacy || !!(legacyOwner && legacyOwner !== scope);
  const legacyFallback = changedIdentity
    ? new Map<string, SessionDraft>()
    : new Map(previous.drafts);
  if (scope) claimedLegacy = true;
  active = scope
    ? (owners.get(scope) ?? draftOwner(scope, changedIdentity ? undefined : previous.drafts))
    : draftOwner(null);
  if (!changedIdentity) {
    active.edited = new Set(previous.edited);
    active.version = previous.version;
  }
  if (scope) owners.set(scope, active);
  try {
    if (changedIdentity) {
      clearReferenceDrafts();
      sessionStorage.removeItem(SESSION_DRAFTS_KEY);
    }
    if (typeof sessionStorage !== "undefined") {
      if (scope) sessionStorage.setItem(`${SESSION_DRAFTS_KEY}.scope`, scope);
      else sessionStorage.removeItem(`${SESSION_DRAFTS_KEY}.scope`);
    }
  } catch (error) {
    reportPersistenceError?.(error);
  }
  const owner = active;
  if (owner.loading) {
    notifyListeners();
    return;
  }
  if (!scope) {
    hydration = writes;
    notifyListeners();
    return;
  }
  if (owner.hydrated) owner.edited.clear();
  for (const id of new Set([...owner.persisted.keys(), ...owner.drafts.keys()])) {
    if (
      owner.persisted.get(id) !== owner.drafts.get(id) &&
      owner.drafts.get(id) !== legacyFallback.get(id)
    )
      owner.edited.add(id);
  }
  owner.loading = true;
  owner.hydrated = false;
  notifyListeners();
  // Retain raw files and deletions until the outgoing owner's transaction completes.
  writes = writes
    .then(async () => {
      const snapshot = await readComposerDraftSnapshot(scope);
      const saved = snapshot ?? new Map<string, SessionDraft>();
      // Legacy text is only a first-paint fallback, never a complete File snapshot.
      if (snapshot) {
        for (const [id, draft] of legacyFallback) {
          if (!owner.edited.has(id) && owner.drafts.get(id) === draft) owner.drafts.delete(id);
        }
      }
      for (const id of owner.persisted.keys()) {
        if (owner.edited.has(id) && owner.drafts.has(id) && !saved.has(id))
          throw new Error("Saved input was removed by another client; keep local edits open");
      }
      for (const id of owner.persisted.keys()) {
        if (!owner.edited.has(id)) owner.drafts.delete(id);
      }
      for (const [id, draft] of saved) {
        if (owner.cleared) continue;
        const promotedId = owner.promotions.get(id);
        if (promotedId) {
          if (!owner.edited.has(promotedId) && !owner.retired.has(promotedId))
            owner.drafts.set(promotedId, draft);
        } else if (!owner.edited.has(id) && !owner.retired.has(id)) {
          owner.drafts.set(id, draft);
        }
      }
      owner.persisted = saved;
      owner.promotions.clear();
      owner.hydrated = true;
      if (owner === active) notifyListeners();
      await save(owner, new Map(owner.drafts), owner.version);
      owner.loading = false;
      if (owner === active) notifyListeners();
    })
    .catch((error) => {
      owner.loading = false;
      failure(owner, error);
    });
  hydration = writes;
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
  const revision = generation;
  await hydration;
  await writes;
  if (revision !== generation) throw new Error("Composer storage identity changed while saving");
  if (active.error !== undefined)
    throw active.error instanceof Error ? active.error : new Error(String(active.error));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function getSessionDraft(conversationId: string): SessionDraft | undefined {
  return active.drafts.get(conversationId);
}

export function setSessionDraft(conversationId: string, draft: SessionDraft): void {
  if (active.retired.has(conversationId)) return;
  active.edited.add(conversationId);
  if (draft.text === "" && draft.files.length === 0 && !draft.mentionedItems?.length) {
    active.drafts.delete(conversationId);
  } else {
    active.drafts.set(conversationId, draft);
  }
  ++active.version;
  saveDraftsToStorage();
  notifyListeners();
}

/** Remove a draft and ignore any late cleanup write for the retired id. */
export function retireSessionDraft(conversationId: string): SessionDraft | undefined {
  const draft = active.drafts.get(conversationId);
  active.retired.add(conversationId);
  active.edited.add(conversationId);
  if (draft === undefined) return undefined;
  active.drafts.delete(conversationId);
  ++active.version;
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
  const draft = active.drafts.get(temporaryConversationId);
  const awaitingSource = active.loading && !active.edited.has(temporaryConversationId);
  if (awaitingSource) active.promotions.set(temporaryConversationId, conversationId);
  if (draft === undefined && !awaitingSource) return undefined;
  active.retired.add(temporaryConversationId);
  active.edited.add(temporaryConversationId);
  active.drafts.delete(temporaryConversationId);
  if (draft !== undefined) active.drafts.set(conversationId, draft);
  if (!awaitingSource) active.edited.add(conversationId);
  ++active.version;
  saveDraftsToStorage();
  notifyListeners();
  return draft;
}

export function hasSessionDraft(conversationId: string): boolean {
  const draft = active.drafts.get(conversationId);
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

/** Failed or unfinished hydration cannot establish an empty browser draft set. */
export function useSessionDraftsHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !active.loading && active.error === undefined,
    () => false,
  );
}

const ignoreDrafts = () => () => {};

function draftIdsKey(): string {
  return [...active.drafts.keys()].filter(hasSessionDraft).sort().join("\n");
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
  if (active.loading || !active.hydrated) active.cleared = true;
  clearReferenceDrafts();
  for (const id of active.drafts.keys()) active.edited.add(id);
  active.drafts.clear();
  active.retired.clear();
  ++active.version;
  saveDraftsToStorage();
  notifyListeners();
}
