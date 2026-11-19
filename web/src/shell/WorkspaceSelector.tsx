// Modified for Triune.
import { useRef, useState, type ButtonHTMLAttributes } from "react";
import { ChevronDownIcon, MonitorIcon } from "lucide-react";
import { DisabledActionTooltip } from "@/components/DisabledActionTooltip";
import { Button } from "@/components/ui/button";
import { COMPOSER_CONTROL_TEXT_CLASS } from "@/components/composer/ComposerControls";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMenuGuardedTooltip } from "@/hooks/useMenuGuardedTooltip";
import { cn } from "@/lib/utils";

export interface WorkspaceSelectorProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  hostLabel: string;
  path: string;
  disabledReason?: string;
  menuOpen?: boolean;
  composer?: boolean;
}

/** Shared borderless host and directory trigger. */
export function WorkspaceSelector({
  hostLabel,
  path,
  disabledReason,
  menuOpen,
  composer = false,
  disabled,
  title,
  className,
  ...props
}: WorkspaceSelectorProps) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [detail, setDetail] = useState<string>();
  const guardedTooltip = useMenuGuardedTooltip(!!menuOpen);
  const location = `${hostLabel}:${path || "Choose path"}`;
  const accessibleLabel = props["aria-label"] ?? `Select workspace: ${location}`;
  const button = (
    <Button
      type="button"
      variant="ghost"
      menuFeedback={composer ? "composer" : undefined}
      size="sm"
      tooltip={false}
      aria-haspopup="dialog"
      aria-expanded={menuOpen}
      aria-label={accessibleLabel}
      disabled={disabled}
      className={cn(
        "h-auto min-h-11 min-w-0 max-w-full shrink gap-1.5 rounded-md border-0 px-2 md:min-h-7",
        COMPOSER_CONTROL_TEXT_CLASS,
        className,
      )}
      {...props}
    >
      <MonitorIcon data-icon-size="14" className="size-3.5 shrink-0" aria-hidden />
      <span
        ref={labelRef}
        data-workspace-collapse-label=""
        className="workspace-selector-details min-w-0 truncate group-data-[labels=collapsed]/composer-actions:hidden group-data-[labels=collapsed]/composer-workspace:hidden"
      >
        <span className="text-muted-foreground">{hostLabel}</span>
        <span className="text-muted-foreground"> · </span>
        <span className="text-foreground">{path || "Choose path"}</span>
      </span>
      <ChevronDownIcon data-icon-size="12" className="size-3 shrink-0" aria-hidden />
    </Button>
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
        setDetail(title ?? (composer || hidden || truncated ? location : undefined));
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
