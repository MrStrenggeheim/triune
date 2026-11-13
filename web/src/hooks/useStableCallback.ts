// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { useCallback, useRef } from "react";

/** Stable event identity with the current render's implementation. */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback((...args: Args) => latest.current(...args), []);
}
