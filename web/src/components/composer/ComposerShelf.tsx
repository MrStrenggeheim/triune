// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./composerShelves.css";

export const COMPOSER_SHELF_MOTION_MS = 200;

/** Retain the last shelf during exit without remounting its live controls. */
export function ComposerShelf({
  present,
  children,
  className,
  retainContent = true,
}: {
  present: boolean;
  children: ReactNode;
  className?: string;
  /** Resolved requests must dismiss their portals while the surface exits. */
  retainContent?: boolean;
}) {
  const [mounted, setMounted] = useState(present);
  const [shown, setShown] = useState(false);
  const retained = useRef(children);
  if (present) retained.current = children;
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function update() {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      if (present) {
        setMounted(true);
        if (media.matches) setShown(true);
        else frame = requestAnimationFrame(() => setShown(true));
      } else {
        setShown(false);
        if (media.matches) setMounted(false);
        else timer = setTimeout(() => setMounted(false), COMPOSER_SHELF_MOTION_MS);
      }
    }
    update();
    media.addEventListener("change", update);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      media.removeEventListener("change", update);
    };
  }, [present]);
  if (!mounted && !present) return null;
  return (
    <div
      ref={(node) => {
        node?.toggleAttribute("inert", !present);
      }}
      className={cn("composer-shelf-presence", className)}
      data-shown={shown}
      data-exiting={!present || undefined}
      aria-hidden={!present || undefined}
    >
      <div className="composer-shelf-clip">
        <div className="composer-shelf-content">
          {present || !retainContent ? children : retained.current}
        </div>
      </div>
    </div>
  );
}
