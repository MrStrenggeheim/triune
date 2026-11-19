// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { XIcon, type LucideIcon } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { TooltipButton } from "./tooltip";
import { cn } from "@/lib/utils";

export function ChipAction({
  label,
  title,
  icon: Icon,
  onClick,
}: {
  label: string;
  title?: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <TooltipButton
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className="shrink-0 cursor-pointer rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-ring"
    >
      <Icon aria-hidden className="size-3" />
    </TooltipButton>
  );
}

export function Chip({
  as: Element = "span",
  children,
  leading,
  remove,
  className,
  ...props
}: ComponentPropsWithoutRef<"span"> & {
  as?: "span" | "li";
  leading: ReactNode;
  remove?: { label: string; onClick: () => void };
}) {
  return (
    <Element
      {...props}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 align-middle text-sm text-muted-foreground",
        className,
      )}
    >
      {leading}
      {children}
      {remove && <ChipAction {...remove} icon={XIcon} />}
    </Element>
  );
}
