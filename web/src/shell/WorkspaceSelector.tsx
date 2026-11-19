// Modified for Triune.
import { useRef, useState, type ButtonHTMLAttributes } from "react";
import { ChevronDownIcon, FolderIcon, MonitorIcon } from "lucide-react";
import { DisabledActionTooltip } from "@/components/DisabledActionTooltip";
import { Button } from "@/components/ui/button";
import { COMPOSER_CONTROL_TEXT_CLASS } from "@/components/composer/ComposerControls";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMenuGuardedTooltip } from "@/hooks/useMenuGuardedTooltip";
import { basename } from "./WorkspacePicker";
import {
  COMPOSER_COLLAPSED_LABEL_CLASS,
  COMPOSER_WORKSPACE_COLLAPSED_LABEL_CLASS,
} from "@/components/composer/ChatComposer";
import { cn } from "@/lib/utils";

export interface WorkspaceSelectorProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  hostLabel: string;
  path: string;
  disabledReason?: string;
  menuOpen?: boolean;
  composer?: boolean;
  hostStatus?: "online" | "offline";
  statusLabel?: string;
}

/** Shared borderless host and directory trigger. */
export function WorkspaceSelector({
  hostLabel,
  path,
  disabledReason,
  menuOpen,
  composer = false,
  hostStatus,
  statusLabel,
  disabled,
  title,
  className,
  ...props
}: WorkspaceSelectorProps) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelClipped, setLabelClipped] = useState(false);
  const guardedTooltip = useMenuGuardedTooltip(!!menuOpen);
  const location = `${hostLabel}:${path || "Choose path"}`;
  const accessibleLabel = props["aria-label"] ?? `Select workspace: ${location}`;
  const showDetail = composer || !!title || labelClipped;
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
      {composer ? (
        <>
          <span
            aria-hidden
            className={cn(
              "relative me-3.5 inline-flex shrink-0 text-muted-foreground",
              COMPOSER_COLLAPSED_LABEL_CLASS,
            )}
          >
            <MonitorIcon data-icon-size="14" className="size-3.5" />
            {hostStatus === "online" && (
              <span className="absolute -bottom-px -right-px size-1.5 rounded-full bg-success ring-1 ring-card" />
            )}
          </span>
          <FolderIcon
            data-icon-size="14"
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </>
      ) : (
        <MonitorIcon data-icon-size="14" className="size-3.5 shrink-0" aria-hidden />
      )}
      <span
        ref={labelRef}
        data-workspace-collapse-label=""
        className={cn(
          "min-w-0 truncate",
          COMPOSER_WORKSPACE_COLLAPSED_LABEL_CLASS,
          composer ? "leading-5" : "workspace-selector-details",
        )}
      >
        {composer ? (
          (statusLabel ?? (path ? basename(path) : "Choose path"))
        ) : (
          <>
            <span className="text-muted-foreground">{hostLabel}</span>
            <span className="text-muted-foreground"> · </span>
            <span className="text-foreground">{path || "Choose path"}</span>
          </>
        )}
      </span>
      <ChevronDownIcon
        data-icon-size="12"
        className={cn("size-3 shrink-0", composer && COMPOSER_COLLAPSED_LABEL_CLASS)}
        aria-hidden
      />
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
      open={guardedTooltip.open && showDetail}
      onOpenChange={(open) => {
        const label = labelRef.current;
        const hidden = label && getComputedStyle(label).display === "none";
        const truncated = label && label.scrollWidth > label.clientWidth;
        setLabelClipped(!!(hidden || truncated));
        guardedTooltip.onOpenChange(open);
      }}
    >
      <TooltipTrigger asChild {...guardedTooltip.triggerProps}>
        {button}
      </TooltipTrigger>
      {showDetail && (
        <TooltipContent>
          {composer && !title ? (
            <span className="flex min-w-0 flex-col break-all">
              <span>
                {hostLabel}
                {hostStatus && (hostStatus === "online" ? " · Connected" : " · Offline")}
              </span>
              <span>{path || "Choose path"}</span>
            </span>
          ) : (
            (title ?? location)
          )}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
