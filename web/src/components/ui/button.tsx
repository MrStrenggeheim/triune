// Modified for Triune.
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import * as Slot from "radix-ui/slot";

import { cn } from "@/lib/utils";
import { Link } from "@/lib/routing";
import { Spinner } from "@/components/ui/spinner";
import { useOmnigentAnalytics } from "@/lib/analytics";
import { buttonLabel, ButtonTooltip, type TooltipShortcut } from "@/components/ui/tooltip";
import { CONTROL_FOCUS_CLASS } from "@/lib/designContract";
import "./button.css";

const mediumHeight = "h-(--button-medium-height)";

// Reserve only the space missing from a 44px touch target. Text, icons, font
// settings and caller widths can all change a Medium button's intrinsic width.
let mediumFaceObserver: ResizeObserver | undefined;
function observeMediumFace(face: HTMLElement) {
  if (typeof ResizeObserver === "undefined") return;
  mediumFaceObserver ??= new ResizeObserver((entries) => {
    for (const { target, borderBoxSize } of entries) {
      const box = borderBoxSize?.[0];
      if (!box || !(target instanceof HTMLElement)) continue;
      target.style.setProperty("--button-face-inline", `${box.inlineSize}px`);
      target.style.setProperty("--button-face-block", `${box.blockSize}px`);
    }
  });
  mediumFaceObserver.observe(face, { box: "border-box" });
}

const buttonVariants = cva(
  [
    "button-standard-icons group/button relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-ui font-normal whitespace-nowrap transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    CONTROL_FOCUS_CLASS,
  ],
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-[var(--primary-hover)] active:bg-[var(--primary-active)]",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "border-button-border bg-secondary text-secondary-foreground hover:bg-[var(--secondary-hover)] active:bg-[var(--secondary-active)] aria-expanded:bg-[var(--secondary-active)] aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-[var(--workspace-control-hover)] hover:text-foreground active:bg-[var(--workspace-control-active)] aria-expanded:bg-[var(--workspace-control-active)] aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: [
          mediumHeight,
          "button-medium gap-(--button-medium-gap) p-(--button-medium-padding) leading-(--button-medium-band) transition-[color,background-color,box-shadow] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        ],
        xs: "h-6 gap-1 rounded-[var(--radius-sm)] px-2 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        sm: "h-7 gap-1 rounded-[var(--radius-md)] px-2.5 text-ui in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-10 md:size-8",
        "icon-xxs":
          "size-3.5 rounded-[var(--radius-sm)] bg-transparent hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent [&_svg]:size-3.5! [&_svg]:p-0!",
        "icon-xs": "size-6 rounded-[var(--radius-md)] in-data-[slot=button-group]:rounded-lg",
        "icon-sm": "size-7 rounded-[var(--radius-md)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    compoundVariants: [
      {
        variant: "ghost",
        size: "icon",
        className: "text-muted-foreground hover:text-foreground",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// Fragments are transparent to flex layout. Children.map carries fragment keys
// into the returned elements so keyed caller components retain their identity.
function flexChildren(children: React.ReactNode): React.ReactNode[] {
  return (
    // oxlint-disable-next-line react/no-react-children -- Preserve React keys across fragment boundaries.
    React.Children.map(children, (child) =>
      React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment
        ? flexChildren(child.props.children)
        : child,
    ) ?? []
  );
}

/** Coalesce interpolated text as the browser does for an anonymous flex item.
 * Inside formatted or truncating labels, move the text ink inside its original
 * wrapper. Custom components, icons and other caller-owned elements stay opaque. */
function mediumContent(children: React.ReactNode, insideLabel = false): React.ReactNode {
  const content: React.ReactNode[] = [];
  let run = "";
  const flush = () => {
    if (!run) return;
    const key = `label-${content.length}`;
    if (run.trim()) {
      const ink = (
        <span key={key} className="button-label-ink">
          {run}
        </span>
      );
      content.push(
        insideLabel ? (
          ink
        ) : (
          <span key={key} className="button-label">
            {ink}
          </span>
        ),
      );
    } else if (insideLabel) content.push(run);
    run = "";
  };
  for (const child of flexChildren(children)) {
    if (typeof child === "string" || typeof child === "number") {
      run += child;
      continue;
    }
    flush();
    if (
      React.isValidElement<{ children?: React.ReactNode }>(child) &&
      typeof child.type === "string" &&
      ["span", "strong", "em", "b", "i", "code"].includes(child.type) &&
      child.props.children != null
    ) {
      content.push(React.cloneElement(child, {}, mediumContent(child.props.children, true)));
      continue;
    }
    content.push(child);
  }
  flush();
  return content;
}

/** Observe release outside the trigger too: Radix can move pointer ownership
 * to a portalled menu on pointerdown. Never capture or cancel its events. */
function holdMenuButton(event: React.PointerEvent<HTMLButtonElement>) {
  if (!event.isPrimary || event.button !== 0) return;
  const button = event.currentTarget;
  const view = button.ownerDocument.defaultView;
  if (!button.matches('[data-menu-feedback], [aria-haspopup="menu"], [aria-haspopup="true"]'))
    return;
  if (
    !view ||
    button.matches(
      ':disabled, [disabled], [aria-disabled="true"], [data-disabled], [aria-busy="true"]',
    )
  )
    return;
  button.dataset.buttonHeld = "";
  const listeners = new view.AbortController();
  const { pointerId } = event;
  const clear = (released: Event) => {
    if ("pointerId" in released && released.pointerId !== pointerId) return;
    delete button.dataset.buttonHeld;
    listeners.abort();
  };
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    view.addEventListener(name, clear, { capture: true, signal: listeners.signal });
  }
  view.addEventListener("blur", clear, { signal: listeners.signal });
}

// forwardRef is required for React 18: Radix primitives that wrap Button via
// `asChild` (e.g. DropdownMenuTrigger) attach a ref to measure the trigger and
// anchor the popper. A plain function component drops that ref on React 18, so
// the popper can't position itself and its content renders off-screen.
const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean;
      /** Ghost menus are recognized by aria-haspopup. Named contexts support
       * custom triggers; nested actions can keep their own surface with false. */
      menuFeedback?: "ordinary" | "composer" | false;
      // When true, overlay a centered spinner and disable the button while
      // keeping its width — the label stays in flow but hidden, so a
      // submitting button doesn't grow and shove its neighbours.
      loading?: boolean;
      // Opt-in analytics id. When set, a click is reported to the host sink
      // (see `lib/analytics.ts`); when absent the button emits nothing, so
      // un-instrumented call sites are unchanged.
      componentId?: string;
      /** Overrides the label inferred from title, aria-label, or visible text. */
      tooltip?: React.ReactNode;
      tooltipDescription?: React.ReactNode;
      tooltipShortcut?: TooltipShortcut;
    }
>(function Button(
  {
    className,
    variant = "default",
    size = "default",
    asChild = false,
    menuFeedback,
    loading = false,
    disabled,
    componentId,
    onClick,
    children,
    title,
    tooltip,
    tooltipDescription,
    tooltipShortcut,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  const { trackClick } = useOmnigentAnalytics();
  const handleClick = componentId
    ? (e: React.MouseEvent<HTMLButtonElement>) => {
        trackClick(componentId, "button");
        onClick?.(e);
      }
    : onClick;

  // With asChild the child is the rendered element (e.g. a Radix trigger or an
  // <a>); we can't inject an overlay without breaking Slot's single-child
  // contract, so the loading affordance only applies to real <button>s.
  const showLoading = loading && !asChild;
  const loadingContentId = React.useId();
  const visibleLabel = buttonLabel(children);
  const accessibleLabel =
    props["aria-label"] ?? (showLoading ? visibleLabel || title : visibleLabel ? undefined : title);
  const feedback = variant === "ghost" ? menuFeedback : undefined;
  const classes = cn(buttonVariants({ variant, size, className }));
  // Tailwind's merge drops the intrinsic height when a caller sizes its own face.
  const mediumTarget = size === "default" && classes.split(" ").includes(mediumHeight);
  const observedFace = React.useRef<HTMLElement | null>(null);
  const bindMediumFace = React.useCallback(
    (node: HTMLButtonElement | null) => {
      if (observedFace.current) mediumFaceObserver?.unobserve(observedFace.current);
      observedFace.current = node;
      if (node) observeMediumFace(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  let content = children;
  if (size === "default") {
    if (!asChild) content = mediumContent(children);
    // Native anchors and routed links accept label children. A slotted custom
    // trigger can require an element child (or a render prop); keep it intact.
    else if (
      React.isValidElement<{ children?: React.ReactNode }>(children) &&
      (children.type === "a" || children.type === Link)
    ) {
      content = React.cloneElement(children, {}, mediumContent(children.props.children));
    }
  }

  const button = (
    <Comp
      ref={mediumTarget ? bindMediumFace : ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-medium-target={mediumTarget || undefined}
      data-component-id={componentId}
      data-menu-feedback={feedback === false ? "off" : feedback}
      className={classes}
      disabled={disabled || showLoading}
      aria-busy={showLoading || undefined}
      onClick={handleClick}
      {...props}
      onPointerDownCapture={
        variant === "ghost" && menuFeedback !== false
          ? (event) => {
              holdMenuButton(event);
              props.onPointerDownCapture?.(event);
            }
          : props.onPointerDownCapture
      }
      type={props.type ?? (asChild ? undefined : "submit")}
      aria-label={accessibleLabel}
      aria-labelledby={
        props["aria-labelledby"] ?? (showLoading && !accessibleLabel ? loadingContentId : undefined)
      }
    >
      {showLoading ? (
        <>
          <Spinner
            aria-hidden="true"
            role="presentation"
            className="absolute inset-0 m-auto size-4"
          />
          {/* `display: contents` keeps children as direct flex items (gap and
              width preserved); `invisible` hides them without removing them. */}
          <span id={loadingContentId} className="contents invisible">
            {content}
          </span>
        </>
      ) : (
        content
      )}
    </Comp>
  );
  return (
    <ButtonTooltip
      enabled={tooltip !== false}
      label={tooltip ?? props["aria-label"] ?? title ?? visibleLabel}
      description={
        tooltipDescription ??
        (title && props["aria-label"] && title !== props["aria-label"] ? title : undefined)
      }
      shortcut={tooltipShortcut}
      expanded={props["aria-expanded"] === true || props["aria-expanded"] === "true"}
    >
      {button}
    </ButtonTooltip>
  );
});

export { Button, buttonVariants };
