// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { forwardRef, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Shared face for compact actions in the composer control row. */
export const ComposerActionButton = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<typeof Button>, "asChild">
>(function ComposerActionButton({ className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      menuFeedback="composer"
      {...props}
      className={cn("size-8 rounded-lg md:size-7", className)}
    />
  );
});
