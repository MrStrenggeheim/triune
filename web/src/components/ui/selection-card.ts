import { cn } from "@/lib/utils";

/** Shared option surface for native answer rows and button-based choice cards. */
export function selectionCardClass(selected: boolean, layout?: string) {
  return cn(
    "rounded-lg border-2 text-foreground transition-[color,background-color,border-color,box-shadow]",
    selected
      ? "border-[var(--workspace-control-active-border)] bg-primary/5"
      : "border-border hover:border-border-strong hover:bg-muted hover:shadow-sm",
    layout,
  );
}
