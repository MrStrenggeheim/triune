// Modified for Triune.
import { useEffect, useSyncExternalStore } from "react";
import { getThemeRoots } from "./host";
import "../listDensity.css";

export const LIST_DENSITY_STORAGE_KEY = "omnigent:list-density";
export const DEFAULT_LIST_DENSITY = "compact";
export const listDensities = ["compact", "comfortable"] as const;
export type ListDensity = (typeof listDensities)[number];
const CHANGE_EVENT = "omnigent:list-density-change";

export function isListDensity(value: unknown): value is ListDensity {
  return value === "compact" || value === "comfortable";
}

export function readListDensity(): ListDensity {
  if (typeof window === "undefined") return DEFAULT_LIST_DENSITY;
  try {
    const stored = window.localStorage.getItem(LIST_DENSITY_STORAGE_KEY);
    return isListDensity(stored) ? stored : DEFAULT_LIST_DENSITY;
  } catch {
    // Unavailable storage uses the same default as a new device.
    return DEFAULT_LIST_DENSITY;
  }
}

/** Apply shared spacing tokens to standalone or embedded theme roots. */
export function applyListDensity(density: ListDensity): void {
  for (const root of getThemeRoots()) {
    root.setAttribute("data-list-density", isListDensity(density) ? density : DEFAULT_LIST_DENSITY);
  }
}

export function writeListDensity(density: ListDensity): void {
  const next = isListDensity(density) ? density : DEFAULT_LIST_DENSITY;
  if (typeof window === "undefined") return;
  try {
    if (next === DEFAULT_LIST_DENSITY) window.localStorage.removeItem(LIST_DENSITY_STORAGE_KEY);
    else window.localStorage.setItem(LIST_DENSITY_STORAGE_KEY, next);
  } catch {
    // A storage failure must not prevent a live spacing update.
  }
  applyListDensity(next);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== LIST_DENSITY_STORAGE_KEY) return;
    if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Mount once in the shell to restore density and follow other windows. */
export function useListDensity(): ListDensity {
  const density = useSyncExternalStore<ListDensity>(
    subscribe,
    readListDensity,
    () => DEFAULT_LIST_DENSITY,
  );
  useEffect(() => applyListDensity(density), [density]);
  return density;
}
