// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Shared polling policy for resource views and fallback reconciles.
//
// A poll runs only while the page is visible and its owning pane, panel or
// popover is active. Data that the session-updates socket pushes polls only
// while that socket is disconnected.

import { useSyncExternalStore } from "react";
import { useSessionUpdatesConnected } from "./useSessionUpdatesConnected";

/** Visible resource data without a push signal, such as activity and shells. */
export const RESOURCE_POLL_MS = 15_000;
/** Safety poll for data that also has a push invalidation, such as git changes. */
export const FALLBACK_POLL_MS = 30_000;

export interface PollingPolicy {
  /** Whether the owning pane, panel or popover currently shows the data. */
  active: boolean;
  /** Poll interval while the page is visible and the owner is active. */
  intervalMs: number;
  /** Session-updates frames keep this data fresh, so polling stops while the socket is connected. */
  pushed?: boolean;
}

export interface PollingEnvironment {
  pageVisible: boolean;
  socketConnected: boolean;
}

/**
 * Resolve a polling policy against the current page and socket state.
 *
 * @param policy - The caller's ownership, interval and push coverage.
 * @param environment - Page visibility and session-updates connection state.
 * @returns The interval in milliseconds, or ``false`` when the caller must not poll.
 */
export function pollingInterval(
  policy: PollingPolicy,
  environment: PollingEnvironment,
): number | false {
  if (!policy.active || !environment.pageVisible) return false;
  if (policy.pushed && environment.socketConnected) return false;
  return policy.intervalMs;
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Whether the document is visible; hidden tabs and minimized windows read ``false``. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/**
 * Polling interval for a TanStack ``refetchInterval`` or a manual timer.
 *
 * @param policy - The caller's ownership, interval and push coverage.
 * @returns The interval in milliseconds, or ``false`` when the caller must not poll.
 */
export function usePollingInterval(policy: PollingPolicy): number | false {
  const pageVisible = usePageVisible();
  const socketConnected = useSessionUpdatesConnected();
  return pollingInterval(policy, { pageVisible, socketConnected });
}
