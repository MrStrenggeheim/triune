// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { forwardRef, type ComponentProps } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CloseButtonProps = Omit<ComponentProps<typeof Button>, "asChild">;

/** Shared close appearance; the caller owns dismissal, propagation and async guards. */
export const CloseButton = forwardRef<HTMLButtonElement, CloseButtonProps>(function CloseButton(
  {
    children,
    className,
    size = "icon-xs",
    variant = "ghost",
    type = "button",
    tooltip = false,
    "aria-label": label = "Close",
    ...props
  },
  ref,
) {
  return (
    <Button
      {...props}
      ref={ref}
      type={type}
      size={size}
      variant={variant}
      tooltip={tooltip}
      aria-label={label}
      data-close-button=""
      className={cn(
        "close-control-button size-6 shrink-0 border-0 p-0 text-muted-foreground hover:text-foreground",
        "bg-transparent hover:bg-transparent dark:hover:bg-transparent aria-expanded:bg-transparent focus-visible:border-transparent focus-visible:ring-0",
        className,
      )}
    >
      <span
        data-close-surface=""
        className="pointer-events-none relative flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] transition-colors group-hover/button:bg-[var(--workspace-close-hover)] group-active/button:bg-[var(--workspace-close-active)] group-focus-visible/button:ring-3 group-focus-visible/button:ring-ring/50"
      >
        {children ?? <XIcon data-icon-size="close" className="size-3.5" aria-hidden="true" />}
      </span>
    </Button>
  );
});
