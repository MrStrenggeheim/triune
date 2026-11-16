// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useSyncExternalStore } from "react";

export const STARTUP_DESTINATION_KEY = "triune:startup-destination";
export type StartupDestination = "continue" | "new";
const changeEvent = "triune:startup-destination-change";

export function readStartupDestination(): StartupDestination {
  try {
    return localStorage.getItem(STARTUP_DESTINATION_KEY) === "new" ? "new" : "continue";
  } catch {
    return "continue";
  }
}

export function writeStartupDestination(value: StartupDestination) {
  try {
    localStorage.setItem(STARTUP_DESTINATION_KEY, value);
  } catch {
    // Device policy may disable persistent preferences.
  }
  window.dispatchEvent(new Event(changeEvent));
}

export function useStartupDestination() {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("storage", listener);
      window.addEventListener(changeEvent, listener);
      return () => {
        window.removeEventListener("storage", listener);
        window.removeEventListener(changeEvent, listener);
      };
    },
    readStartupDestination,
    () => "continue" as const,
  );
}
