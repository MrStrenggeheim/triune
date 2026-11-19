// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { forwardRef, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Keep the compact face centered inside the shelf's responsive input target. */
export const ComposerShelfButton = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<typeof Button>, "asChild" | "loading">
>(function ComposerShelfButton({ children, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="xs"
      {...props}
      menuFeedback="composer"
      className={cn("focus-visible:border-transparent focus-visible:ring-0", className)}
    >
      <span
        data-composer-shelf-face=""
        aria-hidden="true"
        className="border border-transparent group-focus-visible/button:border-[var(--workspace-control-active-border)] group-focus-visible/button:ring-3 group-focus-visible/button:ring-ring/50"
      />
      {children}
    </Button>
  );
});
