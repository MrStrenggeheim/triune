// Modified for Triune; inherited notices remain applicable.
"use client";

import * as React from "react";
import * as TooltipPrimitive from "radix-ui/tooltip";

import { getEmbedRoot } from "@/lib/host";
import { cn } from "@/lib/utils";
import { CompactKbd } from "@/components/ui/kbd";
import { useMenuGuardedTooltip } from "@/hooks/useMenuGuardedTooltip";
import {
  AnchoredPopupProvider,
  useAnchoredPopupBounds,
  usePopupTriggerRef,
} from "./anchored-popup";

type TooltipShortcut = readonly string[] | readonly (readonly string[])[];
const TooltipProviderContext = React.createContext(false);
const TooltipTriggerContext = React.createContext(false);
const TooltipKeyboardFocusContext = React.createContext<React.RefObject<EventTarget | null> | null>(
  null,
);
let activeTooltip: { id: string; close: () => void } | null = null;

function buttonLabel(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (
        !React.isValidElement<{
          children?: React.ReactNode;
          "aria-hidden"?: boolean | "true" | "false";
        }>(child)
      )
        return "";
      if (child.props["aria-hidden"] === true || child.props["aria-hidden"] === "true") return "";
      return buttonLabel(child.props.children);
    })
    .join("")
    .trim();
}

/** A native button with canonical guidance and no styling or layout changes. */
const TooltipButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button"> & {
    tooltip?: React.ReactNode;
    tooltipDescription?: React.ReactNode;
    tooltipShortcut?: TooltipShortcut;
  }
>(function TooltipButton(
  { title, children, tooltip, tooltipDescription, tooltipShortcut, ...props },
  ref,
) {
  return (
    <ButtonTooltip
      enabled={tooltip !== false}
      label={tooltip ?? props["aria-label"] ?? title ?? buttonLabel(children)}
      description={
        tooltipDescription ??
        (title && props["aria-label"] && title !== props["aria-label"] ? title : undefined)
      }
      shortcut={tooltipShortcut}
      expanded={props["aria-expanded"] === true || props["aria-expanded"] === "true"}
    >
      <button
        ref={ref}
        {...props}
        type={props.type ?? "submit"}
        aria-label={props["aria-label"] ?? (buttonLabel(children) ? undefined : title)}
      >
        {children}
      </button>
    </ButtonTooltip>
  );
});

function TooltipShortcutKeys({ shortcut }: { shortcut: TooltipShortcut }) {
  const groups = Array.isArray(shortcut[0])
    ? (shortcut as readonly (readonly string[])[])
    : [shortcut as readonly string[]];

  return (
    <span
      aria-hidden="true"
      data-slot="shortcut-keys"
      className="flex items-center gap-0.5 whitespace-nowrap"
    >
      {groups.map((keys, groupIndex) => (
        <React.Fragment key={`${groupIndex}-${keys.join("-")}`}>
          {groupIndex > 0 && <span className="text-[#767680]">+</span>}
          <span className="inline-flex items-center gap-0.5">
            {keys.map((key, keyIndex) => (
              <CompactKbd key={`${keyIndex}-${key}`}>{key}</CompactKbd>
            ))}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}

function TooltipProvider({
  // Keep incidental pointer movement from flashing tooltips. Callers can still
  // override the delay per provider.
  delayDuration = 600,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const keyboardFocusTarget = React.useRef<EventTarget | null>(null);
  React.useEffect(() => {
    let keyboardNavigationPending = false;
    const onKeyDown = (event: KeyboardEvent) => {
      keyboardNavigationPending = [
        "Tab",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
      ].includes(event.key);
    };
    const onPointerDown = () => {
      keyboardNavigationPending = false;
      keyboardFocusTarget.current = null;
    };
    const onFocusIn = (event: FocusEvent) => {
      keyboardFocusTarget.current = keyboardNavigationPending ? event.target : null;
      keyboardNavigationPending = false;
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, []);
  return (
    <TooltipProviderContext.Provider value={true}>
      <TooltipKeyboardFocusContext.Provider value={keyboardFocusTarget}>
        <TooltipPrimitive.Provider
          data-slot="tooltip-provider"
          delayDuration={delayDuration}
          {...props}
        />
      </TooltipKeyboardFocusContext.Provider>
    </TooltipProviderContext.Provider>
  );
}

function Tooltip({
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const hasProvider = React.useContext(TooltipProviderContext);
  const id = React.useId();
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const [active, setActive] = React.useState(false);
  const requestedOpen = open ?? internalOpen;
  const close = React.useRef(() => {});
  close.current = () => {
    setActive(false);
    setInternalOpen(false);
    onOpenChange?.(false);
  };
  const claim = React.useCallback(() => {
    if (activeTooltip?.id !== id) activeTooltip?.close();
    activeTooltip = { id, close: () => close.current() };
    setActive(true);
  }, [id]);
  React.useLayoutEffect(() => {
    if (requestedOpen) claim();
    else if (activeTooltip?.id === id) {
      activeTooltip = null;
      setActive(false);
    }
  }, [requestedOpen, claim, id]);
  React.useEffect(
    () => () => {
      if (activeTooltip?.id === id) activeTooltip = null;
    },
    [id],
  );
  const root = (
    <AnchoredPopupProvider open={requestedOpen && active}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        {...props}
        open={requestedOpen && active}
        onOpenChange={(next) => {
          if (next && requestedOpen) claim();
          else if (open === undefined) {
            setActive(false);
            if (activeTooltip?.id === id) activeTooltip = null;
          }
          setInternalOpen(next);
          onOpenChange?.(next);
        }}
      />
    </AnchoredPopupProvider>
  );
  return hasProvider ? root : <TooltipProvider>{root}</TooltipProvider>;
}

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger> & {
    suppressNestedTooltip?: boolean;
  }
>(function TooltipTrigger(
  { children, asChild, title, suppressNestedTooltip = true, onFocus, ...props },
  ref,
) {
  const keyboardFocusTarget = React.useContext(TooltipKeyboardFocusContext);
  const triggerRef = usePopupTriggerRef(ref);
  // Strip a trigger's native title at render time; React still owns the DOM.
  const child =
    asChild &&
    React.isValidElement<{ title?: string; "aria-label"?: string; children?: React.ReactNode }>(
      children,
    )
      ? React.cloneElement(children, {
          title: undefined,
          "aria-label":
            children.props["aria-label"] ??
            (buttonLabel(children.props.children) ? undefined : children.props.title),
        })
      : children;
  return (
    <TooltipTriggerContext.Provider value={suppressNestedTooltip}>
      <TooltipPrimitive.Trigger
        ref={triggerRef}
        data-slot="tooltip-trigger"
        asChild={asChild}
        aria-label={title}
        {...props}
        onFocus={(event) => {
          onFocus?.(event);
          // Dialog autofocus must not add a tooltip dismissal layer ahead of Escape.
          const inDialog = event.currentTarget.closest(
            '[role="dialog"], [role="alertdialog"], dialog',
          );
          const keyboardTarget = keyboardFocusTarget?.current;
          if (
            inDialog &&
            !(keyboardTarget instanceof Node && event.currentTarget.contains(keyboardTarget))
          ) {
            event.preventDefault();
          }
        }}
      >
        {child}
      </TooltipPrimitive.Trigger>
    </TooltipTriggerContext.Provider>
  );
});

/** Shared opt-in for native buttons; Button also uses it for existing labels. */
function ButtonTooltip({
  children,
  label,
  description,
  shortcut,
  expanded = false,
  enabled = true,
}: {
  children: React.ReactElement;
  label?: React.ReactNode;
  description?: React.ReactNode;
  shortcut?: TooltipShortcut;
  expanded?: boolean;
  enabled?: boolean;
}) {
  const hasTooltip = React.useContext(TooltipTriggerContext);
  const [renderedLabel, setRenderedLabel] = React.useState("");
  const guarded = useMenuGuardedTooltip(expanded);
  if (hasTooltip || !enabled) return children;
  const resolvedLabel = label || renderedLabel;
  const visibleLabel = buttonLabel((children.props as { children?: React.ReactNode }).children);
  if (
    visibleLabel &&
    typeof resolvedLabel === "string" &&
    visibleLabel.replace(/\s+/g, " ").trim() === resolvedLabel.replace(/\s+/g, " ").trim() &&
    !description &&
    !shortcut?.length
  )
    return children;
  const readLabel = (event: React.SyntheticEvent<HTMLElement>) => {
    if (!label)
      setRenderedLabel(
        event.currentTarget.getAttribute("aria-label") ??
          event.currentTarget.textContent?.trim() ??
          "",
      );
  };
  return (
    <Tooltip open={guarded.open} onOpenChange={guarded.onOpenChange}>
      <TooltipTrigger
        asChild
        onFocus={readLabel}
        onPointerEnter={(event) => {
          readLabel(event);
          guarded.triggerProps.onPointerEnter();
        }}
      >
        {children}
      </TooltipTrigger>
      {resolvedLabel && (
        <TooltipContent description={description} shortcut={shortcut}>
          {resolvedLabel}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

function TooltipContent({
  className,
  side = "top",
  children,
  shortcut,
  description,
  align: _align,
  sideOffset: _sideOffset,
  collisionPadding,
  style,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  shortcut?: TooltipShortcut;
  description?: React.ReactNode;
}) {
  const bounds = useAnchoredPopupBounds(collisionPadding, { maxWidth: 272, ...style });
  return (
    <TooltipPrimitive.Portal container={getEmbedRoot() ?? undefined}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        side={side === "bottom" ? "bottom" : "top"}
        align="center"
        sideOffset={8}
        collisionPadding={bounds.collisionPadding}
        className={cn(
          "z-50 w-fit max-w-[272px] origin-(--radix-tooltip-content-transform-origin)",
          className,
          "rounded-[7px] border border-[#e2e2e8] bg-white px-[11px] py-[9px] text-[13px] leading-[1.45] font-medium text-[#30303a] shadow-[0_3px_12px_#2020300d] **:data-[slot=kbd]:min-w-[19px] **:data-[slot=kbd]:h-[20px] **:data-[slot=kbd]:w-auto **:data-[slot=kbd]:rounded-[3px] **:data-[slot=kbd]:border-[#e5e5eb] **:data-[slot=kbd]:bg-[#fafafb] **:data-[slot=kbd]:text-[11px] **:data-[slot=kbd]:font-normal **:data-[slot=kbd]:text-[#767680] data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        )}
        {...props}
        style={{
          ...bounds.style,
          maxHeight:
            "min(320px, var(--radix-tooltip-content-available-height, calc(100dvh - 16px)))",
          overflow: "auto",
          overscrollBehavior: "contain",
          overflowWrap: "anywhere",
          whiteSpace: "pre-wrap",
          backgroundColor: "#fff",
          color: "#30303a",
          borderColor: "#e2e2e8",
          borderRadius: 7,
          boxShadow: "0 3px 12px #2020300d",
        }}
      >
        <div className="flex min-w-0 items-center justify-between gap-3.5">
          <span className="min-w-0">{children}</span>
          {shortcut && shortcut.length > 0 && <TooltipShortcutKeys shortcut={shortcut} />}
        </div>
        {description && (
          <div className="mt-[5px] text-xs leading-[1.5] font-normal text-[#777781]">
            {description}
          </div>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export {
  buttonLabel,
  ButtonTooltip,
  TooltipButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
};
export type { TooltipShortcut };
