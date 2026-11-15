import { forwardRef, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Compact header chrome inside a separate, non-overlapping mobile touch target. */
export const HeaderActionButton = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<typeof Button>, "asChild" | "loading">
>(function HeaderActionButton({ children, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon-xs"
      {...props}
      data-header-action-button
      className={cn(
        className,
        "size-6 max-md:size-11 shrink-0 border-0 p-0 text-muted-foreground hover:text-foreground",
        "bg-transparent hover:bg-transparent dark:hover:bg-transparent aria-expanded:bg-transparent focus-visible:border-transparent focus-visible:ring-0",
      )}
    >
      <span
        data-header-action-surface
        className="pointer-events-none relative flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] transition-colors [&_svg:not([data-icon-size])]:size-4 [&_svg:not([data-icon-size])]:p-0 group-hover/button:bg-[var(--workspace-control-hover)] group-active/button:bg-[var(--workspace-control-active)] group-aria-expanded/button:bg-[var(--workspace-control-active)] group-focus-visible/button:ring-3 group-focus-visible/button:ring-ring/50"
      >
        {children}
      </span>
    </Button>
  );
});
