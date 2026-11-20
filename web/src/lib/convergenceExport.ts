// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { authenticatedFetch } from "./identity";
import { resourceViewStorageScope } from "./resourceViewStorage";

export interface ExportReceipt {
  stage: "received" | "accepted" | "displayed" | "recovery";
  at: number;
  conversationId: string;
  itemId?: string;
  attemptId?: string;
  viewId?: string;
  kind?: string;
  reason?: string;
  position?: number;
  revision?: number;
  ordinal?: number;
  folded?: boolean;
}
interface Entry extends ExportReceipt {
  page: string;
  seq: number;
  visible: boolean;
}
interface Outbox {
  scope: string;
  until: number;
  page: string;
  seq: number;
  dropped: number;
  records: Entry[];
}

const key = "triune:display-outbox:v1";
const maxEntries = 1024;
let box: Outbox | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = false;
let delay = 2000;

function persist() {
  if (!box) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(box));
  } catch {
    // Bounded memory continues to serve this page when storage is unavailable.
  }
}

function schedule() {
  if (!box?.records.length || timer !== undefined || sending) return;
  timer = setTimeout(() => void send(), delay);
}

export function configureConvergenceExport(until: number) {
  const scope = resourceViewStorageScope();
  if (box?.until === until && box.scope === scope && until > Date.now()) return;
  clearTimeout(timer);
  timer = undefined;
  box = undefined;
  if (!Number.isSafeInteger(until) || until <= Date.now()) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Storage can be disabled. */
    }
    return;
  }
  let saved: Outbox | undefined;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw && raw.length < 1024 * 1024) {
      const prior = JSON.parse(raw) as Outbox;
      if (
        prior.scope === scope &&
        prior.until === until &&
        Array.isArray(prior.records) &&
        prior.records.length <= maxEntries &&
        Number.isSafeInteger(prior.seq) &&
        typeof prior.page === "string"
      )
        saved = prior;
    }
  } catch {
    /* Start a fresh queue on malformed storage. */
  }
  // A duplicated browser tab may inherit sessionStorage. Its new rows need an independent sequence.
  box = {
    scope,
    until,
    page: crypto.randomUUID(),
    seq: 0,
    dropped: saved?.dropped ?? 0,
    records: saved?.records.map((row) => ({ ...row, page: row.page ?? saved.page })) ?? [],
  };
  delay = 2000;
  schedule();
}

export function enqueueConvergenceReceipt(receipt: ExportReceipt) {
  // Heartbeats carry no transcript state; exporting them only adds upload traffic.
  if (!box || receipt.kind === "heartbeat") return;
  if (box.until <= Date.now() || box.scope !== resourceViewStorageScope()) {
    configureConvergenceExport(0);
    return;
  }
  if (box.records.length === maxEntries) {
    box.records.shift();
    box.dropped++;
  }
  box.records.push({
    ...receipt,
    page: box.page,
    seq: ++box.seq,
    visible: document.visibilityState === "visible",
  });
  schedule();
}

async function digest(value?: string) {
  if (!value) return undefined;
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function send() {
  timer = undefined;
  const owner = box;
  if (!owner || sending || !owner.records.length) return;
  if (owner.until <= Date.now() || owner.scope !== resourceViewStorageScope()) {
    configureConvergenceExport(0);
    return;
  }
  persist();
  sending = true;
  const { conversationId: session, page } = owner.records[0]!;
  const batch = owner.records
    .filter((row) => row.conversationId === session && row.page === page)
    .slice(0, 64);
  try {
    const records = await Promise.all(
      batch.map(async (row) => {
        const [item, attempt, view] = await Promise.all([
          digest(row.itemId),
          digest(row.attemptId),
          digest(row.viewId),
        ]);
        return {
          seq: row.seq,
          at: row.at,
          stage: row.stage,
          kind: row.kind,
          reason: row.reason,
          item,
          attempt,
          view,
          position: row.position,
          revision: row.revision,
          ordinal: row.ordinal,
          folded: row.folded,
          visible: row.visible,
        };
      }),
    );
    if (owner !== box || owner.scope !== resourceViewStorageScope()) return;
    const response = await authenticatedFetch(
      `/v1/sessions/${encodeURIComponent(session)}/display-receipts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page, dropped: owner.dropped, records }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok && ![401, 403, 404, 422].includes(response.status))
      throw new Error("Display receipt not acknowledged");
    if (owner !== box) return;
    if (!response.ok) owner.dropped += records.length;
    const delivered = new Set(records.map((row) => row.seq));
    owner.records = owner.records.filter((row) => row.page !== page || !delivered.has(row.seq));
    delay = owner.records.length ? 100 : 2000;
    persist();
  } catch {
    delay = Math.min(30000, Math.max(2000, delay * 2));
  } finally {
    sending = false;
    schedule();
  }
}
if (typeof window !== "undefined") window.addEventListener("pagehide", persist);
