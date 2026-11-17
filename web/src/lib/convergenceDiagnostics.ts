// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { getCurrentUserId } from "./identity";
import { getOmnigentServerIdentity } from "./host";
import { resourceViewStorageScope } from "./resourceViewStorage";
import type { AnyBlock } from "./blocks";

export const CONVERGENCE_STORAGE_KEY = "triune:convergence:v1";
export const CONVERGENCE_MAX_RECORDS = 256;
export const CONVERGENCE_MAX_BYTES = 64_000;
export const CONVERGENCE_RETENTION_MS = 24 * 60 * 60 * 1000;
const stages = ["received", "accepted", "displayed", "recovery"] as const;
const kinds = ["sync", "heartbeat", "item", "delta", "state", "render"] as const;
const reasons = ["diverged", "invalid_sync", "deadline", "transport"] as const;
type Stage = (typeof stages)[number];
export interface ConvergenceIdentity {
  bindingId?: string;
  attemptId?: string;
  attemptGeneration?: number;
  syncGeneration?: number;
}
interface Detail extends ConvergenceIdentity {
  conversationId: string;
  itemId?: string;
  kind?: (typeof kinds)[number];
  reason?: (typeof reasons)[number];
  position?: number;
  revision?: number;
  count?: number;
}
interface RecordEntry extends Detail {
  stage: Stage;
  at: number;
}
interface Journal {
  scope: string;
  dropped: number;
  records: RecordEntry[];
}
let journal: Journal | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let activeScope: string | undefined;
let hydration: Promise<void> = Promise.resolve();
const accepted = new Map<string, ConvergenceIdentity>();
const acceptedBlocks = new WeakMap<AnyBlock, { scope: string; identity: ConvergenceIdentity }>();
const hydrated = new WeakSet<Journal>();
const buckets = new Map<string, RecordEntry>();
const sizes = new WeakMap<RecordEntry, number>();
let retainedBytes = 0;
function bucketKey(record: RecordEntry): string {
  return JSON.stringify([
    record.stage,
    record.conversationId,
    record.bindingId,
    record.attemptId,
    record.syncGeneration,
    record.kind,
    record.reason,
    record.itemId,
  ]);
}
function account(record: RecordEntry): void {
  const size = JSON.stringify(record).length * 2 + 2;
  retainedBytes += size - (sizes.get(record) ?? 0);
  sizes.set(record, size);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
function sanitize(value: unknown): RecordEntry | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  if (
    !stages.includes(raw.stage as Stage) ||
    !validId(raw.conversationId) ||
    typeof raw.at !== "number" ||
    !Number.isSafeInteger(raw.at) ||
    raw.at < Date.now() - CONVERGENCE_RETENTION_MS ||
    raw.at > Date.now()
  )
    return;
  const record: RecordEntry = {
    stage: raw.stage as Stage,
    conversationId: raw.conversationId,
    at: raw.at,
  };
  for (const key of ["bindingId", "attemptId", "itemId"] as const)
    if (validId(raw[key])) record[key] = raw[key];
  if (kinds.includes(raw.kind as Detail["kind"] & string)) record.kind = raw.kind as Detail["kind"];
  if (reasons.includes(raw.reason as Detail["reason"] & string))
    record.reason = raw.reason as Detail["reason"];
  for (const key of [
    "position",
    "revision",
    "count",
    "attemptGeneration",
    "syncGeneration",
  ] as const) {
    const number = raw[key];
    if (
      typeof number === "number" &&
      Number.isSafeInteger(number) &&
      number >= (key === "position" ? -1 : 0)
    )
      record[key] = number;
  }
  return record;
}
function trim(value: Journal): void {
  while (
    value.records.length &&
    (value.records.length > CONVERGENCE_MAX_RECORDS ||
      retainedBytes > CONVERGENCE_MAX_BYTES - 512 ||
      value.records[0].at < Date.now() - CONVERGENCE_RETENTION_MS)
  ) {
    const removed = value.records.shift()!;
    retainedBytes -= sizes.get(removed) ?? 0;
    const key = bucketKey(removed);
    if (buckets.get(key) === removed) buckets.delete(key);
    value.dropped++;
  }
}
function current(): Journal {
  const scope = resourceViewStorageScope();
  if (journal && activeScope === scope) {
    trim(journal);
    return journal;
  }
  activeScope = scope;
  accepted.clear();
  buckets.clear();
  retainedBytes = 0;
  const value = { scope: "", dropped: 0, records: [] } as Journal;
  journal = value;
  hydration = (async () => {
    if (!getCurrentUserId() || !getOmnigentServerIdentity()) return;
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
      if (journal !== value || resourceViewStorageScope() !== scope) return;
      value.scope = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const encoded = localStorage.getItem(CONVERGENCE_STORAGE_KEY);
      if (encoded && encoded.length <= CONVERGENCE_MAX_BYTES / 2) {
        const saved = JSON.parse(encoded) as Journal;
        if (saved.scope === value.scope && Array.isArray(saved.records)) {
          value.dropped +=
            Number.isSafeInteger(saved.dropped) && saved.dropped >= 0 ? saved.dropped : 0;
          const retained: RecordEntry[] = [];
          for (const raw of saved.records) {
            const record = sanitize(raw);
            if (record) retained.push(record);
            else value.dropped++;
          }
          value.records = [...retained, ...value.records];
          retainedBytes = 0;
          buckets.clear();
          for (const record of value.records) {
            sizes.delete(record);
            account(record);
            buckets.set(bucketKey(record), record);
          }
        }
      }
    } catch {
      /* Storage or crypto unavailable: retain bounded memory only. */
    }
    trim(value);
    hydrated.add(value);
  })();
  return value;
}
export async function flushConvergenceDiagnostics(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  const value = current();
  const scope = activeScope;
  if (!hydrated.has(value)) await hydration;
  if (journal !== value || resourceViewStorageScope() !== scope || !value.scope) return;
  try {
    localStorage.setItem(CONVERGENCE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* Quota or privacy settings must not interrupt transcript delivery. */
  }
}
export function recordConvergence(stage: Stage, detail: Detail): void {
  const value = current();
  const record = sanitize({ ...detail, stage, at: Date.now() });
  if (!record) {
    value.dropped++;
    return;
  }
  if (stage === "accepted") {
    const key = JSON.stringify([record.conversationId, record.itemId ?? null]);
    accepted.delete(key);
    accepted.set(key, {
      bindingId: record.bindingId,
      attemptId: record.attemptId,
      attemptGeneration: record.attemptGeneration,
      syncGeneration: record.syncGeneration,
    });
    if (accepted.size > CONVERGENCE_MAX_RECORDS) accepted.delete(accepted.keys().next().value!);
  }
  const key = bucketKey(record);
  const last = buckets.get(key);
  if (last && record.at - last.at < 1000) {
    Object.assign(last, {
      ...record,
      at: last.at,
      count: (last.count ?? 1) + (record.count ?? 1),
    });
    account(last);
  } else {
    value.records.push(record);
    buckets.set(key, record);
    account(record);
  }
  trim(value);
  timer ??= setTimeout(flushConvergenceDiagnostics, 500);
}
/** Export only sanitized, current-viewer metadata; never event payloads. */
export function readConvergenceDiagnostics(): Journal {
  return structuredClone(current());
}
/** Called by a mounted transcript after React commits its visible rows. */
export function recordTranscriptDisplayed(
  conversationId: string,
  detail: Pick<Detail, "position" | "itemId" | "count"> & ConvergenceIdentity,
  expectedScope = resourceViewStorageScope(),
): void {
  if (expectedScope !== resourceViewStorageScope()) return;
  recordConvergence("displayed", { conversationId, ...detail, kind: "render" });
}
/** Capture at render scheduling time; never relabel an old frame with a newer attempt. */
export function readConvergenceIdentity(
  conversationId: string,
  itemId?: string,
): ConvergenceIdentity | undefined {
  current();
  const identity = accepted.get(JSON.stringify([conversationId, itemId ?? null]));
  return identity ? { ...identity } : undefined;
}
/** Stamp only the immutable block objects published by this accepted update. */
export function stampConvergenceBlocks(
  blocks: readonly AnyBlock[],
  identity: ConvergenceIdentity,
): void {
  const scope = resourceViewStorageScope();
  for (const block of blocks) acceptedBlocks.set(block, { scope, identity: { ...identity } });
}
/** An older rendered object never inherits a newer update's synchronization identity. */
export function readBlockConvergenceIdentity(block: AnyBlock): ConvergenceIdentity | undefined {
  const stamp = acceptedBlocks.get(block);
  return stamp?.scope === resourceViewStorageScope() ? { ...stamp.identity } : undefined;
}
if (typeof window !== "undefined") window.addEventListener("pagehide", flushConvergenceDiagnostics);
