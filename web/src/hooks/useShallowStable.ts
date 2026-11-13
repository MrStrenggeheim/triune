// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { useRef } from "react";
import { shallow } from "zustand/shallow";

/** Preserve identity only while every top-level value remains equal. */
export function useShallowStable<T extends object | undefined>(value: T): T {
  const previous = useRef(value);
  if (!shallow(previous.current, value)) previous.current = value;
  return previous.current;
}
