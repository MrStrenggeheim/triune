import { forwardRef, type ComponentProps, type CSSProperties } from "react";
import { HeaderActionButton } from "@/components/HeaderActionButton";
import { cn } from "@/lib/utils";

/** The outline stays identical; only the sidebar's narrow segment fills when open. */
export function SidebarPanelIcon({
  side,
  expanded = false,
  className,
}: {
  side: "left" | "right";
  expanded?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-4", className)}
      data-panel-side={side}
      data-panel-filled={expanded}
    >
      {expanded && (
        <path
          fill="currentColor"
          stroke="none"
          d={
            side === "left"
              ? "M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
              : "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4Z"
          }
        />
      )}
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d={side === "left" ? "M9 3v18" : "M15 3v18"} />
    </svg>
  );
}

/** Matches the 44px controls centered in the 56px mobile chat header. */
export function mobileSidebarToggleStyle(side: "left" | "right"): CSSProperties {
  return {
    top: "calc(max(0px, calc(var(--omnigent-safe-top, 0px) - 0.5rem)) + 0.375rem)",
    [side]: `max(0.5rem, var(--omnigent-safe-${side}, 0px))`,
  };
}

export const SidebarToggle = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<typeof HeaderActionButton>, "aria-expanded"> & {
    side: "left" | "right";
    expanded: boolean;
  }
>(function SidebarToggle({ side, expanded, className, ...props }, ref) {
  return (
    <HeaderActionButton
      ref={ref}
      aria-expanded={expanded}
      className={cn("[&>[data-header-action-surface]]:bg-transparent!", className)}
      {...props}
    >
      <SidebarPanelIcon side={side} expanded={expanded} />
    </HeaderActionButton>
  );
});
