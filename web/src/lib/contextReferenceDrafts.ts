import type { ComposerReference } from "./contextReferences";

const prefix = "omnigent.contextReferenceDraft:";
const listeners = new Map<string, Set<() => void>>();
export function readReferenceDraft(id: string): ComposerReference[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(prefix + id) ?? "[]");
    return Array.isArray(value)
      ? value.filter(
          (item) =>
            (item?.version === 2 &&
              typeof item.url === "string" &&
              /^https?:\/\//i.test(item.url) &&
              typeof item.source_id === "string" &&
              typeof item.source_title === "string") ||
            (item?.version === 1 &&
              typeof item.snapshot_id === "string" &&
              Array.isArray(item.items)),
        )
      : [];
  } catch {
    return [];
  }
}
export function writeReferenceDraft(id: string, references: ComposerReference[]): void {
  const next = references.length ? JSON.stringify(references) : null;
  if (sessionStorage.getItem(prefix + id) === next) return;
  if (next) sessionStorage.setItem(prefix + id, next);
  else sessionStorage.removeItem(prefix + id);
  listeners.get(id)?.forEach((listener) => listener());
}
export function subscribeReferenceDraft(id: string, listener: () => void): () => void {
  const subscribers = listeners.get(id) ?? new Set();
  subscribers.add(listener);
  listeners.set(id, subscribers);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(id);
  };
}
export function clearReferenceDrafts(): void {
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith(prefix)) sessionStorage.removeItem(key);
  for (const subscribers of listeners.values()) subscribers.forEach((listener) => listener());
}
