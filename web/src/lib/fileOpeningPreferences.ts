// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { useSyncExternalStore } from "react";

export const FILE_OPENING_KEY = "triune:file-opening";
export const fileOpeningModes = ["same", "beside", "split", "reuse"] as const;
export type FileOpeningMode = (typeof fileOpeningModes)[number];
export const fileOpeningLabels: Record<FileOpeningMode, string> = {
  same: "Same pane",
  beside: "Beside",
  split: "Always split",
  reuse: "Reuse pane",
};
export function readFileOpening(): FileOpeningMode {
  try {
    const value = localStorage.getItem(FILE_OPENING_KEY);
    return fileOpeningModes.includes(value as FileOpeningMode)
      ? (value as FileOpeningMode)
      : "beside";
  } catch {
    return "beside";
  }
}
export function writeFileOpening(value: FileOpeningMode) {
  try {
    localStorage.setItem(FILE_OPENING_KEY, value);
  } catch {
    /* Device policy may disallow storage. */
  }
  window.dispatchEvent(new Event("triune:file-opening-change"));
}
export function useFileOpening() {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("storage", listener);
      window.addEventListener("triune:file-opening-change", listener);
      return () => {
        window.removeEventListener("storage", listener);
        window.removeEventListener("triune:file-opening-change", listener);
      };
    },
    readFileOpening,
    () => "beside" as const,
  );
}
