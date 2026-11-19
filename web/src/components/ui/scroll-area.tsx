"use client";

import * as React from "react";
import * as ScrollAreaPrimitive from "radix-ui/scroll-area";

import { cn } from "@/lib/utils";
import { ScrollbarThumb } from "@/components/ui/overlay-scrollbar";

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/12 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none select-none data-horizontal:h-3 data-horizontal:items-end data-horizontal:pb-0.5 data-vertical:h-full data-vertical:w-3 data-vertical:flex-col data-vertical:items-end data-vertical:pr-0.5",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb asChild>
        <ScrollbarThumb
          data-slot="scroll-area-thumb"
          orientation={orientation}
          className="relative right-auto bottom-auto shrink-0"
        />
      </ScrollAreaPrimitive.ScrollAreaThumb>
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
