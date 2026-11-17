// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
const observedInputs = new Set<string>();

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
  for (const key of ["conversationId", "stableId", "pendingId", "itemId"] as const) {
    const value = identifiers[key];
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)) detail[key] = value;
  }
  const identity = `${detail.conversationId ?? ""}:${detail.itemId ?? ""}`;
  if (stage === "rendered" && !observedInputs.has(identity)) return;
  if (stage !== "rendered" && detail.itemId) {
    if (observedInputs.size >= 256) observedInputs.delete(observedInputs.values().next().value!);
    observedInputs.add(identity);
  }
  const name = "triune.input.lifecycle";
  if (performance.getEntriesByName(name).length >= 256) performance.clearMarks(name);
  performance.mark(name, { detail });
}
