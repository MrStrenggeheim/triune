// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";

const PopupContext = createContext<{
  open: boolean;
  trigger: HTMLElement | null;
  setTrigger: (node: HTMLElement | null) => void;
}>({ open: false, trigger: null, setTrigger: () => {} });

export function AnchoredPopupProvider({ children, open }: { children: ReactNode; open: boolean }) {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  return (
    <PopupContext.Provider value={{ trigger, setTrigger, open }}>{children}</PopupContext.Provider>
  );
}

export function usePopupTriggerRef<T extends HTMLElement>(ref: Ref<T> | undefined) {
  const { setTrigger } = useContext(PopupContext);
  return useCallback(
    (node: T | null) => {
      setTrigger(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref, setTrigger],
  );
}

/** Supply horizontal bounds; Radix still owns placement, shifting and flipping. */
export function useAnchoredPopupBounds(
  padding: number | Partial<Record<"top" | "bottom" | "left" | "right", number>> = 8,
  style?: CSSProperties,
  enabled = true,
) {
  const { trigger, open } = useContext(PopupContext);
  const [bounds, setBounds] = useState({ left: 0, right: 0 });
  useLayoutEffect(() => {
    if (!trigger || !enabled || !open) return;
    const column = trigger.closest<HTMLElement>(".composer-shelf-stack, [data-composer-card]");
    if (!column) return;
    const win = trigger.ownerDocument.defaultView!;
    const measure = () => {
      const rect = column.getBoundingClientRect();
      if (!rect.width) return;
      const css = win.getComputedStyle(column);
      const left = rect.left + (parseFloat(css.paddingLeft) || 0);
      const right = win.innerWidth - rect.right + (parseFloat(css.paddingRight) || 0);
      setBounds((previous) =>
        previous.left === left && previous.right === right ? previous : { left, right },
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(column);
    win.addEventListener("resize", measure);
    win.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      win.removeEventListener("resize", measure);
      win.removeEventListener("scroll", measure, true);
    };
  }, [trigger, enabled, open]);
  const insets =
    typeof padding === "number"
      ? { top: padding, bottom: padding, left: padding, right: padding }
      : padding;
  return {
    collisionPadding: {
      ...insets,
      left: Math.max(insets.left ?? 8, bounds.left),
      right: Math.max(insets.right ?? 8, bounds.right),
    },
    style: {
      ...style,
      minWidth: 0,
      maxWidth: `min(${typeof style?.maxWidth === "number" ? `${style.maxWidth}px` : (style?.maxWidth ?? "100vw")}, var(--radix-popper-available-width, calc(100vw - 16px)))`,
    } as CSSProperties,
  };
}

export function usePopupOpenState(props: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(props.defaultOpen ?? false);
  return {
    open: props.open ?? internalOpen,
    onOpenChange: (next: boolean) => {
      setInternalOpen(next);
      props.onOpenChange?.(next);
    },
  };
}
