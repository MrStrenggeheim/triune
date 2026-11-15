// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { PointerEvent } from "react";

/** Pointer events distinguish real mouse hover from emulated touch hover. */
export function recordPointerInput(event: PointerEvent<HTMLElement>) {
  event.currentTarget.dataset.input = event.pointerType || "unknown";
}

export const pointerInputProps = {
  "data-input": "mouse",
  onPointerEnter: recordPointerInput,
  onPointerMove: recordPointerInput,
  onPointerDownCapture: recordPointerInput,
};
