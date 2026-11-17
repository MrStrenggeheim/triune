// Modified for Triune.
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import * as Slot from "radix-ui/slot";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { useOmnigentAnalytics } from "@/lib/analytics";
import { buttonLabel, ButtonTooltip, type TooltipShortcut } from "@/components/ui/tooltip";
import { CONTROL_FOCUS_CLASS } from "@/lib/designContract";

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
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
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

// forwardRef is required for React 18: Radix primitives that wrap Button via
// `asChild` (e.g. DropdownMenuTrigger) attach a ref to measure the trigger and
// anchor the popper. A plain function component drops that ref on React 18, so
// the popper can't position itself and its content renders off-screen.
const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean;
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

  const button = (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-component-id={componentId}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || showLoading}
      aria-busy={showLoading || undefined}
      onClick={handleClick}
      {...props}
      type={props.type ?? (asChild ? undefined : "submit")}
      aria-label={
        props["aria-label"] ??
        (showLoading ? buttonLabel(children) || title : buttonLabel(children) ? undefined : title)
      }
    >
      {showLoading ? (
        <>
          <Spinner className="absolute inset-0 m-auto size-4" />
          {/* `display: contents` keeps children as direct flex items (gap and
              width preserved); `invisible` hides them without removing them. */}
          <span className="contents invisible">{children}</span>
        </>
      ) : (
        children
      )}
    </Comp>
  );
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
      {button}
    </ButtonTooltip>
  );
});

export { Button, buttonVariants };
