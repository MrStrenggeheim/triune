// Modified for Triune; inherited notices remain applicable.
"use client";

import * as React from "react";
import * as PopoverPrimitive from "radix-ui/popover";

import { getEmbedRoot } from "@/lib/host";
import { cn } from "@/lib/utils";
import {
  AnchoredPopupProvider,
  usePopupTriggerRef,
  useAnchoredPopupBounds,
  usePopupOpenState,
} from "./anchored-popup";

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const state = usePopupOpenState(props);
  return (
    <AnchoredPopupProvider open={state.open}>
      <PopoverPrimitive.Root data-slot="popover" {...props} {...state} />
    </AnchoredPopupProvider>
  );
}

const PopoverTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(function PopoverTrigger(props, ref) {
  const triggerRef = usePopupTriggerRef(ref);
  return <PopoverPrimitive.Trigger ref={triggerRef} data-slot="popover-trigger" {...props} />;
});

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  collisionPadding,
  style,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const bounds = useAnchoredPopupBounds(collisionPadding, style, !props.hidden, side, sideOffset);
  return (
    <PopoverPrimitive.Portal container={getEmbedRoot() ?? undefined} forceMount={props.forceMount}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        {...bounds}
        side={side}
        align={side === "left" || side === "right" ? align : "center"}
        className={cn(
          "z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-ui text-popover-foreground shadow-menu ring-1 ring-foreground/10 outline-hidden duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-ui", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <div data-slot="popover-title" className={cn("font-medium", className)} {...props} />;
}

function PopoverDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
