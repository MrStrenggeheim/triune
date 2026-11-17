// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ReactNode } from "react";
import { Spinner } from "./spinner";
import { cn } from "@/lib/utils";

/** Initial content placeholder; callers keep already-loaded content mounted. */
export function ContentSkeleton({
  label,
  className,
  rows = 3,
}: {
  label: string;
  className?: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-label={label} className={cn("w-full space-y-2 p-3", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className={cn("h-4 rounded bg-muted", index === rows - 1 && "w-2/3")}
        />
      ))}
    </div>
  );
}

/** Actual operation feedback with a stable decorative indicator slot. */
export function OperationStatus({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        <Spinner role="presentation" aria-hidden="true" className="size-3.5" />
      </span>
      <span>{children}</span>
    </span>
  );
}
