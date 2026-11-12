// Modified for Triune.
import { useRef, useState, type ButtonHTMLAttributes } from "react";
import { ChevronDownIcon, MonitorIcon } from "lucide-react";
import { DisabledActionTooltip } from "@/components/DisabledActionTooltip";
import { COMPOSER_CONTROL_TEXT_CLASS } from "@/components/composer/ComposerControls";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMenuGuardedTooltip } from "@/hooks/useMenuGuardedTooltip";
import { cn } from "@/lib/utils";

export interface WorkspaceSelectorProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  hostLabel: string;
  path: string;
  disabledReason?: string;
  menuOpen?: boolean;
}

/** Shared borderless host and directory trigger. */
export function WorkspaceSelector({
  hostLabel,
  path,
  disabledReason,
  menuOpen = false,
  disabled,
  title,
  className,
  ...props
}: WorkspaceSelectorProps) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [detail, setDetail] = useState<string>();
  const guardedTooltip = useMenuGuardedTooltip(menuOpen);
  const location = `${hostLabel}:${path || "Choose path"}`;
  const accessibleLabel = props["aria-label"] ?? `Select workspace: ${location}`;
  const button = (
    <button
      type="button"
      aria-label={accessibleLabel}
      disabled={disabled}
      className={cn(
        "inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 md:min-h-7",
        COMPOSER_CONTROL_TEXT_CLASS,
        className,
      )}
      {...props}
    >
      <MonitorIcon className="size-3.5 shrink-0" aria-hidden />
      <span
        ref={labelRef}
        data-workspace-collapse-label=""
        className="workspace-selector-details min-w-0 truncate group-data-[labels=collapsed]/composer-actions:hidden group-data-[labels=collapsed]/composer-workspace:hidden"
      >
        <span className="text-muted-foreground">{hostLabel}</span>
        <span className="text-muted-foreground"> · </span>
        <span className="text-foreground">{path || "Choose path"}</span>
      </span>
      <ChevronDownIcon className="size-3 shrink-0" aria-hidden />
    </button>
  );
  if (disabled && disabledReason) {
    return (
      <DisabledActionTooltip reason={disabledReason} label={accessibleLabel} className="min-w-0">
        {button}
      </DisabledActionTooltip>
    );
  }
  return (
    <Tooltip
      open={guardedTooltip.open && !!detail}
      onOpenChange={(open) => {
        const label = labelRef.current;
        const hidden = label && getComputedStyle(label).display === "none";
        const truncated = label && label.scrollWidth > label.clientWidth;
        setDetail(title ?? (hidden || truncated ? location : undefined));
        guardedTooltip.onOpenChange(open);
      }}
    >
      <TooltipTrigger asChild {...guardedTooltip.triggerProps}>
        {button}
      </TooltipTrigger>
      {detail && <TooltipContent>{detail}</TooltipContent>}
    </Tooltip>
  );
}
