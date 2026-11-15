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

async function transaction(scope: string, value?: unknown): Promise<unknown> {
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
      const tx = database.transaction(STORE, value === undefined ? "readonly" : "readwrite");
      const request =
        value === undefined
          ? tx.objectStore(STORE).get(scope)
          : tx.objectStore(STORE).put(value, scope);
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

/** IndexedDB stores full attachment bytes as well as FIFO order and reply metadata. */
export async function writeQueuedMessages(scope: string, messages: QueuedMessage[]): Promise<void> {
  const stored = await Promise.all(
    messages.map(async ({ files, ...message }): Promise<StoredMessage> => ({
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
  await transaction(scope, { version: 1, messages: stored });
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
  let activeScope: string | null = null;
  let loading = false;
  let stopped = false;
  let generation = 0;
  let writes = Promise.resolve();
  let hydration = Promise.resolve();
  let reported = false;
  let lastError: unknown;
  const failure = (error: unknown) => {
    lastError = error;
    if (!stopped && !reported) {
      reported = true;
      reportError(error);
    }
  };
  const save = (owner: string, messages: QueuedMessage[]) => {
    writes = writes
      .then(() => writeQueuedMessages(owner, messages))
      .then(() => {
        reported = false;
        lastError = undefined;
      })
      .catch(failure);
  };
  const refreshScope = () => {
    const next = scope();
    if (next === activeScope || stopped) return;
    const priorScope = activeScope;
    activeScope = next;
    const revision = ++generation;
    loading = true;
    if (priorScope !== null) store.setState({ queuedMessages: [] });
    if (!next) {
      loading = false;
      return;
    }
    hydration = writes
      .then(() => readQueuedMessages(next))
      .then((saved) => {
        if (stopped || revision !== generation) return;
        const current = store.getState().queuedMessages;
        const ids = new Set(current.map((message) => message.stableId ?? message.queueId));
        const messages = [
          ...saved.filter((message) => !ids.has(message.stableId ?? message.queueId)),
          ...current,
        ];
        store.setState({ queuedMessages: messages });
        loading = false;
        save(next, messages);
        restored?.();
      })
      .catch((error) => {
        if (revision !== generation || stopped) return;
        loading = false;
        failure(error);
      });
  };
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.queuedMessages === previous.queuedMessages) return;
    if (scope() !== activeScope) {
      refreshScope();
      return;
    }
    if (!loading && activeScope) save(activeScope, state.queuedMessages);
  });
  refreshScope();
  return {
    refreshScope,
    settled: async () => {
      await hydration;
      await writes;
    },
    saved: async () => {
      await hydration;
      await writes;
      if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
): Promise<void> {
  const entries = await Promise.all(
    [...drafts].map(async ([id, { files, ...draft }]) => [
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
  await transaction(`composer:${scope}`, { version: 1, drafts: Object.fromEntries(entries) });
}

export async function readComposerDrafts(scope: string): Promise<Map<string, SessionDraft>> {
  const saved = (await transaction(`composer:${scope}`)) as
    | {
        version: number;
        drafts: Record<string, Omit<SessionDraft, "files"> & { files: StoredFile[] }>;
      }
    | undefined;
  if (saved === undefined) return new Map();
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
