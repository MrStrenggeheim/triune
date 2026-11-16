// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useRef, useState } from "react";
import { readStartupDestination } from "@/lib/startupPreferences";
import { ApiError, getSessionSlim } from "@/lib/sessionsApi";

/** Apply the startup preference once, only to an unqualified cold home launch. */
export function useStartupConversation({
  active,
  href,
  entryKey,
  ownerId,
  navigate,
  onError,
}: {
  active: boolean;
  href: string;
  entryKey: string;
  ownerId: string | null;
  navigate: (path: string, options: { replace: boolean }) => void;
  onError: (error: unknown) => void;
}) {
  const [destination] = useState(() =>
    active && href === "/" && readStartupDestination() === "continue" ? ownerId : null,
  );
  const [pending, setPending] = useState(Boolean(destination));
  const initialEntry = useRef(entryKey);
  const settled = useRef(false);
  useEffect(() => {
    if (!destination || settled.current) return;
    if (!active || href !== "/" || entryKey !== initialEntry.current) {
      settled.current = true;
      setPending(false);
      return;
    }
    const controller = new AbortController();
    void getSessionSlim(destination, { signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        settled.current = true;
        setPending(false);
        navigate(`/c/${encodeURIComponent(destination)}`, { replace: true });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        settled.current = true;
        setPending(false);
        if (!(error instanceof ApiError && [403, 404, 410].includes(error.status))) onError(error);
      });
    return () => controller.abort();
  }, [active, href, entryKey, destination, navigate, onError]);
  return pending;
}
