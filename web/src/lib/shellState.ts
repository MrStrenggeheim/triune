// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { AgentStatus } from "@/shell/subagentStatus";

interface ShellEvidence {
  status?: string | null;
  exitCode?: number | null;
  connectivity?: string;
  /** Only a producer with a documented zero-exit guarantee may set this. */
  completedMeansSuccess?: boolean;
}

/** `stopped` is the service's successful Stop receipt; vendor `killed` is not. */
export function shellState({
  status,
  exitCode,
  connectivity,
  completedMeansSuccess = false,
}: ShellEvidence): AgentStatus & { ended: boolean } {
  const ended = [
    "completed",
    "exited",
    "stopped",
    "killed",
    "declined",
    "failed",
    "ended",
  ].includes(status ?? "");
  const details = Number.isInteger(exitCode) ? `Exit code: ${exitCode}` : undefined;
  const result = (activity: AgentStatus["activity"], label: string) => ({
    activity,
    label,
    details,
    ended,
  });
  if (status === "stopped") return result("other", "Stopped");
  if (status === "declined") return result("other", "Declined");
  if (ended) {
    if (status === "failed" || (Number.isInteger(exitCode) && exitCode !== 0))
      return result("failed", "Failed");
    if (exitCode === 0 || (status === "completed" && completedMeansSuccess))
      return result("done", "Completed");
    return result("other", "Ended");
  }
  if (connectivity === "disconnected" || status === "disconnected")
    return result("disconnected", "Disconnected");
  if (connectivity != null && connectivity !== "connected") return result("other", "Unknown");
  if (status === "running" || status === "in_progress" || status === "inProgress")
    return result("working", "Running");
  if (status === "idle") return result("idle", "Shell open");
  return result("other", "Unknown");
}
