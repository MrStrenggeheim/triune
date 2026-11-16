import type { MouseEvent } from "react";

/** Claim only the middle button; auxclick owns the action once, down only blocks paste/autoscroll. */
export function middleClickHandlers(onOpen: () => void) {
  return {
    onMouseDown(event: MouseEvent<HTMLElement>) {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onAuxClick(event: MouseEvent<HTMLElement>) {
      if (event.button !== 1 || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onOpen();
    },
  };
}
