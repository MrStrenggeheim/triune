// Modified for Triune.

"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { createElement, memo, useMemo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

// Crossfade three static gradient snapshots to suggest a traveling highlight
// without repainting a text-clipped background every frame.
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  return createElement(
    Component,
    {
      className: `text-shimmer ${cn("relative inline-block text-muted-foreground", className)}`,
      style: {
        "--spread": `${dynamicSpread}px`,
        "--shimmer-duration": `${duration}s`,
      } as CSSProperties,
    },
    children,
    ...[0, 1, 2].map((phase) =>
      createElement("span", {
        key: phase,
        "aria-hidden": true,
        className: "text-shimmer-highlight",
        "data-text": children,
      }),
    ),
  );
};

export const Shimmer = memo(ShimmerComponent);
