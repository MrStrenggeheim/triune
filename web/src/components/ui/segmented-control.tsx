import type { ComponentProps, ReactNode } from "react";
import * as TabsPrimitive from "radix-ui/tabs";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger, type TooltipShortcut } from "./tooltip";
import { cn } from "@/lib/utils";

const track = "flex h-6 w-fit shrink-0 items-center gap-0.5 rounded-[6px] bg-muted p-0";
const item =
  "h-6 rounded-[6px] border border-transparent px-2.5 py-0 text-muted-foreground hover:bg-transparent hover:text-foreground";
const selectedItem = "border-border bg-background text-foreground shadow-sm hover:bg-background";

/** Shared track and pressed states for compact, single-choice controls. */
export function SegmentedControl({ className, ...props }: ComponentProps<"div">) {
  return (
    <div role="group" data-slot="segmented-control" className={cn(track, className)} {...props} />
  );
}

export function SegmentedControlItem({
  label,
  active,
  iconOnly = false,
  shortcut,
  tooltipSide = "top",
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  label: string;
  active: boolean;
  iconOnly?: boolean;
  shortcut?: TooltipShortcut;
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant={active ? "secondary" : "ghost"}
            size={iconOnly ? "icon-xs" : "xs"}
            tooltip={false}
            aria-label={label}
            aria-pressed={active}
            className={cn(item, iconOnly && "w-9", active && selectedItem, className)}
            {...props}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} shortcut={shortcut}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Radix owns focus, selection and the links to the editor panels. */
export function EditorModeTabs({ label, value }: { label: string; value: string }) {
  return (
    <TabsPrimitive.List aria-label={label} className={track} data-slot="segmented-control">
      {["Write", "Preview"].map((name) => {
        const mode = name.toLowerCase();
        return (
          <TabsPrimitive.Trigger key={mode} value={mode} asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={cn(item, value === mode && selectedItem)}
            >
              {name}
            </Button>
          </TabsPrimitive.Trigger>
        );
      })}
    </TabsPrimitive.List>
  );
}
