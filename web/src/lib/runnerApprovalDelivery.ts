// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

export interface RunnerApprovalDelivery {
  state: "unconfirmed";
  session_id: string;
  elicitation_id: string;
  attempt_id: string;
  runner_id: string;
  owner_kind: "runner" | "harness";
}

export function parseRunnerApprovalDelivery(value: unknown): RunnerApprovalDelivery | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  if (
    raw.state !== "unconfirmed" ||
    !["session_id", "elicitation_id", "attempt_id", "runner_id"].every(
      (key) => typeof raw[key] === "string" && raw[key] !== "",
    ) ||
    (raw.owner_kind !== "runner" && raw.owner_kind !== "harness")
  )
    return;
  return {
    state: "unconfirmed",
    session_id: raw.session_id as string,
    elicitation_id: raw.elicitation_id as string,
    attempt_id: raw.attempt_id as string,
    runner_id: raw.runner_id as string,
    owner_kind: raw.owner_kind,
  };
}
