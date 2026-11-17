// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useState } from "react";

/** Keep pointer-restored focus neutral until the next keyboard interaction. */
export function useMenuInputIntent(open: boolean) {
  const [pointerInteraction, setPointerInteraction] = useState(false);
  useEffect(() => {
    if (open || !pointerInteraction) return;
    const onKeyDown = () => setPointerInteraction(false);
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, pointerInteraction]);
  return { pointerInteraction, setPointerInteraction };
}
