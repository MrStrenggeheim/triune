// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
/** Content-free browser milestones, available in the local Performance timeline. */
export function markInputLifecycle(
  stage: "submitted" | "accepted" | "consumed" | "rendered",
  identifiers: {
    conversationId?: string | null;
    stableId?: string;
    pendingId?: string;
    itemId?: string;
  },
) {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  const detail: Record<string, string | number> = { stage, observedAtMs: Date.now() };
  for (const [key, value] of Object.entries(identifiers))
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)) detail[key] = value;
  const name = "triune.input.lifecycle";
  if (performance.getEntriesByName(name).length >= 256) performance.clearMarks(name);
  performance.mark(name, { detail });
}
