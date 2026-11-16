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

function getPopupAnchorRow(trigger: HTMLElement) {
  const nearest = trigger.closest<HTMLElement>(
    ".workbench-app-bar, .chat-header, .workspace-control-header, .composer-shelf-content, .composer-shelf-surface",
  );
  return nearest?.closest<HTMLElement>(".composer-shelf-content") ?? nearest;
}

/** Trigger-relative offsets that mirror visible control insets outside its row. */
export function getPopupRowOffsets(trigger: HTMLElement) {
  const row = getPopupAnchorRow(trigger);
  if (!row) return null;
  const surface = trigger.querySelector<HTMLElement>("[data-header-action-surface]") ?? trigger;
  const outer = row.getBoundingClientRect();
  const target = trigger.getBoundingClientRect();
  const paint = surface.getBoundingClientRect();
  if (!outer.height || !target.height || !paint.height) return null;
  // Shelves overlap the next card by their radius; that overlap is not a row inset.
  const bottom =
    outer.bottom +
    Math.min(
      0,
      parseFloat(trigger.ownerDocument.defaultView!.getComputedStyle(row).marginBottom) || 0,
    );
  return {
    top: target.top - outer.top + Math.max(0, paint.top - outer.top),
    bottom: bottom - target.bottom + Math.max(0, bottom - paint.bottom),
  };
}

/** Supply row spacing and bounds; Radix owns placement, shifting and flipping. */
export function useAnchoredPopupBounds(
  padding: number | Partial<Record<"top" | "bottom" | "left" | "right", number>> = 8,
  style?: CSSProperties,
  enabled = true,
  side: "top" | "bottom" | "left" | "right" = "bottom",
  sideOffset = 4,
  forwardedRef?: Ref<HTMLDivElement>,
) {
  const { trigger, open } = useContext(PopupContext);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      setContent(node);
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  const [bounds, setBounds] = useState({
    left: 0,
    right: 0,
    offset: sideOffset,
    reserve: 0,
    row: false,
  });
  useLayoutEffect(() => {
    if (!trigger || !enabled || !open) return;
    const column = trigger.closest<HTMLElement>(".composer-shelf-stack, [data-composer-card]");
    const row = getPopupAnchorRow(trigger);
    const vertical = side === "top" || side === "bottom";
    const surface = trigger.querySelector<HTMLElement>("[data-header-action-surface]") ?? trigger;
    const win = trigger.ownerDocument.defaultView!;
    const measure = () => {
      let left = 0,
        right = 0,
        offset = sideOffset,
        reserve = 0,
        anchored = false;
      if (column) {
        const rect = column.getBoundingClientRect();
        const css = win.getComputedStyle(column);
        if (rect.width) {
          left = rect.left + (parseFloat(css.paddingLeft) || 0);
          right = win.innerWidth - rect.right + (parseFloat(css.paddingRight) || 0);
        }
      }
      if (row && vertical) {
        const offsets = getPopupRowOffsets(trigger);
        if (offsets) {
          const actualSide = content?.getAttribute("data-side") ?? side;
          offset = actualSide === "top" ? offsets.top : offsets.bottom;
          // Keep Radix's fit budget constant across asymmetric side changes.
          reserve = Math.max(offsets.top, offsets.bottom) - offset;
          anchored = true;
        }
      }
      setBounds((previous) =>
        previous.left === left &&
        previous.right === right &&
        previous.offset === offset &&
        previous.reserve === reserve &&
        previous.row === anchored
          ? previous
          : { left, right, offset, reserve, row: anchored },
      );
    };
    measure();
    if (!column && !(row && vertical)) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const node of new Set([column, row, trigger, surface])) if (node) observer?.observe(node);
    const mutation = new MutationObserver(measure);
    if (content && row && vertical)
      mutation.observe(content, { attributes: true, attributeFilter: ["data-side"] });
    for (const node of new Set([
      row,
      column,
      trigger.closest("[data-list-density]"),
      trigger.ownerDocument.documentElement,
    ]))
      if (node)
        mutation.observe(node, {
          attributes: true,
          attributeFilter: ["class", "style", "data-list-density"],
        });
    win.addEventListener("resize", measure);
    win.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      mutation.disconnect();
      win.removeEventListener("resize", measure);
      win.removeEventListener("scroll", measure, true);
    };
  }, [trigger, content, enabled, open, side, sideOffset]);
  const insets =
    typeof padding === "number"
      ? { top: padding, bottom: padding, left: padding, right: padding }
      : padding;
  return {
    ref: contentRef,
    sideOffset: enabled && open ? bounds.offset : sideOffset,
    "data-popup-row-anchor": (enabled && open && bounds.row) || undefined,
    collisionPadding: {
      ...insets,
      top: (insets.top ?? 0) + (enabled && open ? bounds.reserve : 0),
      bottom: (insets.bottom ?? 0) + (enabled && open ? bounds.reserve : 0),
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
