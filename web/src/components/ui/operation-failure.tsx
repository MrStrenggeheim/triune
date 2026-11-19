// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ComponentProps, ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A recoverable operation error with an optional neutral retry action. */
export function OperationFailure({
  children,
  className,
  onRetry,
  retrying = false,
  retryLabel = "Retry",
  role = "alert",
  ...props
}: Omit<ComponentProps<typeof Alert>, "children" | "role"> & {
  children: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
  role?: "alert" | "status";
}) {
  return (
    <Alert
      {...props}
      role={role}
      variant="destructive"
      className={cn(
        "flex items-center justify-between gap-2 border-0",
        onRetry && "pr-2.5",
        className,
      )}
    >
      <AlertDescription className="min-w-0 break-words">{children}</AlertDescription>
      {onRetry && (
        <Button
          type="button"
          variant="ghost"
          className="shrink-0 text-foreground"
          loading={retrying}
          onClick={onRetry}
        >
          {retryLabel}
        </Button>
      )}
    </Alert>
  );
}
