// Modified for Triune.
import type { SessionDraft } from "./sessionDrafts";
import type { QueuedMessage } from "@/store/chatStore";
import { readComposerDraft } from "./replyDraft";
import { randomUUID } from "./randomUUID";

const DATABASE = "omnigent-message-queues";
const STORE = "queues";
interface StoredFile {
  name: string;
  type: string;
  lastModified: number;
  data: ArrayBuffer;
}
type StoredMessage = Omit<QueuedMessage, "files"> & { files?: StoredFile[] };
interface QueueState {
  queuedMessages: QueuedMessage[];
}
interface QueueStore {
  getState: () => QueueState;
  setState: (state: QueueState) => void;
  subscribe: (listener: (state: QueueState, previous: QueueState) => void) => () => void;
}

async function transaction(scope: string, update?: (saved: unknown) => unknown): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Queue database upgrade is blocked"));
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, update ? "readwrite" : "readonly");
      const store = tx.objectStore(STORE);
      const request = store.get(scope);
      if (update) {
        request.onsuccess = () => {
          try {
            store.put(update(request.result), scope);
          } catch (error) {
            tx.abort();
            reject(error);
          }
        };
      }
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Queue storage transaction aborted"));
    });
  } finally {
    database.close();
  }
}

function fileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** Only changed entries are written; an absent observed entry is a remote deletion. */
function mergeEntries<T>(
  saved: Map<string, T>,
  previous: Map<string, unknown>,
  current: Map<string, unknown>,
  changed: Map<string, T>,
): Map<string, T> {
  for (const id of previous.keys()) {
    if (!current.has(id)) saved.delete(id);
  }
  for (const [id, value] of changed) {
    if (previous.has(id) && !saved.has(id))
      throw new Error("Saved input was removed by another client; keep local edits open");
    saved.set(id, value);
  }
  return saved;
}

const queueEntries = <T extends { queueId: string }>(messages: T[]) =>
  new Map(messages.map((message) => [message.queueId, message]));

function orderMessages<T extends { queueId: string }>(
  merged: Map<string, T>,
  previous: Map<string, unknown>,
  current: Map<string, unknown>,
): T[] {
  const priorOrder = [...previous.keys()].filter((id) => current.has(id));
  const currentOrder = [...current.keys()].filter((id) => previous.has(id));
  const reordered = priorOrder.some((id, index) => id !== currentOrder[index]);
  const messages = [...merged.values()];
  if (!reordered && ![...current.keys()].some((id) => !previous.has(id))) return messages;
  const ordered = [...current.keys()].filter((id) => merged.has(id));
  let index = 0;
  return messages.map((message) =>
    current.has(message.queueId) ? merged.get(ordered[index++])! : message,
  );
}

function savedMessages(value: unknown): StoredMessage[] {
  if (value === undefined) return [];
  const saved = value as { version?: number; messages?: StoredMessage[] };
  if (saved.version !== 1 || !Array.isArray(saved.messages)) throw new Error("Invalid saved queue");
  return saved.messages;
}

/** Pass the previous committed snapshot to patch entries; omit only for exclusively owned keys. */
export async function writeQueuedMessages(
  scope: string,
  messages: QueuedMessage[],
  previous?: QueuedMessage[],
): Promise<void> {
  const prior = queueEntries(previous ?? []);
  const current = queueEntries(messages);
  const stored = await Promise.all(
    messages
      .filter((message) => previous === undefined || prior.get(message.queueId) !== message)
      .map(async ({ files, ...message }): Promise<StoredMessage> => ({
        ...message,
        ...(files?.length
          ? {
              files: await Promise.all(
                files.map(async (file) => ({
                  name: file.name,
                  type: file.type,
                  lastModified: file.lastModified,
                  data: await fileBytes(file),
                })),
              ),
            }
          : {}),
      })),
  );
  await transaction(scope, (value) => {
    const latest = savedMessages(value);
    if (previous === undefined) return { version: 1, messages: stored };
    const merged = mergeEntries(queueEntries(latest), prior, current, queueEntries(stored));
    const ordered = orderMessages(merged, prior, current);
    return { ...(value as object), version: 1, messages: ordered };
  });
}

export async function readQueuedMessages(scope: string): Promise<QueuedMessage[]> {
  const value = (await transaction(scope)) as
    { version?: number; messages?: StoredMessage[] } | undefined;
  if (value === undefined) return [];
  if (value.version !== 1 || !Array.isArray(value.messages)) throw new Error("Invalid saved queue");
  return value.messages.map((message) => {
    if (
      !message ||
      typeof message.queueId !== "string" ||
      typeof message.conversationId !== "string" ||
      typeof message.text !== "string"
    ) {
      throw new Error("Invalid saved queued message");
    }
    const draft = readComposerDraft(message)!;
    const files = message.files?.map((file) => {
      if (
        !file ||
        typeof file.name !== "string" ||
        typeof file.type !== "string" ||
        Object.prototype.toString.call(file.data) !== "[object ArrayBuffer]"
      )
        throw new Error("Queued attachment unavailable");
      return new File([file.data], file.name, { type: file.type, lastModified: file.lastModified });
    });
    return {
      queueId: message.queueId,
      conversationId: message.conversationId,
      ...draft,
      stableId:
        typeof message.stableId === "string" && message.stableId
          ? message.stableId
          : randomUUID().replace(/-/g, ""),
      ...(message.agentId ? { agentId: message.agentId } : {}),
      ...(typeof message.hostId === "string" ? { hostId: message.hostId } : {}),
      ...(typeof message.workspaceRoot === "string"
        ? { workspaceRoot: message.workspaceRoot }
        : {}),
      ...(typeof message.workspaceRevision === "string"
        ? { workspaceRevision: message.workspaceRevision }
        : {}),
      ...(message.serverState ? { serverState: message.serverState } : {}),
      ...(message.serverContent ? { serverContent: message.serverContent } : {}),
      ...(message.fileMetadata ? { fileMetadata: message.fileMetadata } : {}),
      ...(message.dispatching ? { dispatching: true } : {}),
      ...(message.deliveryError ? { deliveryError: message.deliveryError } : {}),
      ...(files?.length ? { files } : {}),
      ...(message.command === "compact" ? { command: "compact" as const } : {}),
      ...(message.requiresRetry || !message.stableId ? { requiresRetry: true } : {}),
      ...(message.waitingForHost ? { waitingForHost: true } : {}),
    };
  });
}

/** Install once at app boot; identity changes never restore another user's queue. */
export function persistMessageQueue({
  store,
  scope,
  reportError,
  restored,
}: {
  store: QueueStore;
  scope: () => string | null;
  reportError: (error: unknown) => void;
  restored?: () => void;
}) {
  interface Owner {
    scope: string;
    messages: QueuedMessage[];
    persisted: QueuedMessage[];
    removed: Set<string>;
    loading: boolean;
    hydrated: boolean;
    error?: unknown;
    reported: boolean;
  }
  const owners = new Map<string, Owner>();
  let active: Owner | undefined;
  let initial = store.getState().queuedMessages;
  let stopped = false;
  let publishing: QueuedMessage[] | undefined;
  let generation = 0;
  let writes = Promise.resolve();
  const publish = (owner?: Owner) => {
    if (stopped) return;
    const snapshot = owner?.messages ?? [];
    const previous = publishing;
    publishing = snapshot;
    try {
      store.setState({ queuedMessages: snapshot });
    } finally {
      publishing = previous;
    }
  };
  const failure = (owner: Owner, error: unknown) => {
    owner.error = error;
    if (!stopped && active === owner && !owner.reported) {
      owner.reported = true;
      reportError(error);
    }
  };
  const save = async (owner: Owner, messages: QueuedMessage[]) => {
    await writeQueuedMessages(owner.scope, messages, owner.persisted);
    owner.persisted = messages;
    if (owner.messages === messages) owner.removed.clear();
    owner.error = undefined;
    owner.reported = false;
  };
  const refreshScope = () => {
    const next = scope();
    if (next === (active?.scope ?? null) || stopped) return;
    ++generation;
    if (!next) {
      active = undefined;
      initial = [];
      publish();
      return;
    }
    let owner = owners.get(next);
    if (!owner) {
      owner = {
        scope: next,
        messages: initial,
        persisted: [],
        removed: new Set(),
        loading: false,
        hydrated: false,
        reported: false,
      };
      initial = [];
      owners.set(next, owner);
    }
    active = owner;
    publish(owner);
    if (owner.loading) return;
    const pending = owner;
    pending.loading = true;
    pending.hydrated = false;
    // Finish the captured owner's merge/save even after that identity leaves the UI.
    writes = writes
      .then(async () => {
        const saved = await readQueuedMessages(pending.scope);
        const current = queueEntries(pending.messages);
        const previous = queueEntries(pending.persisted);
        const changed = queueEntries(
          pending.messages.filter((message) => previous.get(message.queueId) !== message),
        );
        const merged = mergeEntries(queueEntries(saved), previous, current, changed);
        for (const id of pending.removed) merged.delete(id);
        pending.messages = orderMessages(merged, previous, current);
        pending.persisted = saved;
        pending.removed.clear();
        pending.hydrated = true;
        if (active === pending && scope() === pending.scope) {
          publish(pending);
          if (!stopped) restored?.();
        }
        await save(pending, pending.messages);
        pending.loading = false;
      })
      .catch((error) => {
        pending.loading = false;
        failure(pending, error);
      });
  };
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.queuedMessages === publishing || state.queuedMessages === previous.queuedMessages)
      return;
    if (scope() !== (active?.scope ?? null)) {
      refreshScope();
      return;
    }
    if (!active) return;
    const owner = active;
    const ids = new Set(state.queuedMessages.map((message) => message.queueId));
    if (owner.loading || !owner.hydrated) {
      for (const message of previous.queuedMessages) {
        if (!ids.has(message.queueId)) owner.removed.add(message.queueId);
      }
      for (const id of ids) owner.removed.delete(id);
    }
    owner.messages = state.queuedMessages;
    if (owner.hydrated) {
      const snapshot = owner.messages;
      writes = writes.then(() => save(owner, snapshot)).catch((error) => failure(owner, error));
    }
  });
  refreshScope();
  const settled = async () => {
    await writes;
    await writes;
  };
  return {
    refreshScope,
    settled,
    saved: async () => {
      const revision = generation;
      await settled();
      if (revision !== generation) throw new Error("Queue storage identity changed while saving");
      if (active?.error !== undefined)
        throw active.error instanceof Error ? active.error : new Error(String(active.error));
    },
    dispose: () => {
      stopped = true;
      unsubscribe();
    },
  };
}

/** Composer snapshots share the queue's byte-preserving, scoped IDB transaction. */
export async function writeComposerDrafts(
  scope: string,
  drafts: Map<string, SessionDraft>,
  previous?: Map<string, SessionDraft>,
): Promise<void> {
  const entries = await Promise.all(
    [...drafts]
      .filter(([id, draft]) => previous === undefined || previous.get(id) !== draft)
      .map(async ([id, { files, ...draft }]) => [
        id,
        {
          ...draft,
          files: await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              type: file.type,
              lastModified: file.lastModified,
              data: await fileBytes(file),
            })),
          ),
        },
      ]),
  );
  await transaction(`composer:${scope}`, (value) => {
    const saved = value as { version: number; drafts: Record<string, unknown> } | undefined;
    if (
      saved !== undefined &&
      (saved.version !== 1 ||
        !saved.drafts ||
        typeof saved.drafts !== "object" ||
        Array.isArray(saved.drafts))
    )
      throw new Error("Invalid saved composer");
    const changed = new Map<string, unknown>(entries as [string, unknown][]);
    const merged =
      previous === undefined
        ? changed
        : mergeEntries(new Map(Object.entries(saved?.drafts ?? {})), previous, drafts, changed);
    return { ...saved, version: 1, drafts: Object.fromEntries(merged) };
  });
}

export async function readComposerDrafts(scope: string): Promise<Map<string, SessionDraft>> {
  return (await readComposerDraftSnapshot(scope)) ?? new Map();
}

/** Null means no migrated snapshot; an empty map is an authoritative empty snapshot. */
export async function readComposerDraftSnapshot(
  scope: string,
): Promise<Map<string, SessionDraft> | null> {
  const saved = (await transaction(`composer:${scope}`)) as
    | {
        version: number;
        drafts: Record<string, Omit<SessionDraft, "files"> & { files: StoredFile[] }>;
      }
    | undefined;
  if (saved === undefined) return null;
  if (saved.version !== 1 || !saved.drafts || typeof saved.drafts !== "object")
    throw new Error("Invalid saved composer");
  return new Map(
    Object.entries(saved.drafts).map(([id, value]) => {
      const draft = readComposerDraft(value);
      if (!draft || !Array.isArray(value.files)) throw new Error("Invalid saved composer draft");
      const files = value.files.map((file) => {
        if (
          !file ||
          typeof file.name !== "string" ||
          typeof file.type !== "string" ||
          typeof file.lastModified !== "number" ||
          Object.prototype.toString.call(file.data) !== "[object ArrayBuffer]"
        )
          throw new Error("Composer attachment unavailable");
        return new File([file.data], file.name, {
          type: file.type,
          lastModified: file.lastModified,
        });
      });
      return [
        id,
        {
          ...draft,
          files,
          ...(Array.isArray(value.mentionedItems) ? { mentionedItems: value.mentionedItems } : {}),
        },
      ];
    }),
  );
}
