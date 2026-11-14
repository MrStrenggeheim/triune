// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import { shellState } from "./shellState";

it.each([
  ["exited", 0, "Completed", "done"],
  ["exited", 8, "Failed", "failed"],
  ["exited", undefined, "Ended", "other"],
  ["completed", undefined, "Ended", "other"],
  ["completed", -1, "Failed", "failed"],
  ["failed", 0, "Failed", "failed"],
  ["declined", -1, "Declined", "other"],
  ["stopped", 0, "Stopped", "other"],
  ["stopped", -1, "Stopped", "other"],
  ["stopped", undefined, "Stopped", "other"],
  ["killed", undefined, "Ended", "other"],
  ["killed", -9, "Failed", "failed"],
  ["completed", NaN, "Ended", "other"],
  ["completed", 1.5, "Ended", "other"],
] as const)("maps confirmed %s / %s evidence to %s", (status, exitCode, label, activity) => {
  expect(shellState({ status, exitCode })).toMatchObject({ label, activity, ended: true });
});

it.each([
  ["running", "Running", "working"],
  ["idle", "Shell open", "idle"],
  ["in_progress", "Running", "working"],
  ["disconnected", "Disconnected", "disconnected"],
  [undefined, "Unknown", "other"],
  ["unknown", "Unknown", "other"],
] as const)(
  "never infers termination from %s, even with a stale exit code",
  (status, label, activity) => {
    expect(shellState({ status, exitCode: -1 })).toMatchObject({ label, activity, ended: false });
  },
);

it("requires an explicit producer contract for bare completed and keeps contradictory evidence", () => {
  expect(shellState({ status: "completed", completedMeansSuccess: true }).label).toBe("Completed");
  expect(shellState({ status: "completed", completedMeansSuccess: true, exitCode: 2 }).label).toBe(
    "Failed",
  );
  expect(shellState({ status: "running", connectivity: "disconnected" })).toMatchObject({
    label: "Disconnected",
    ended: false,
  });
  expect(shellState({ status: "running", connectivity: "unknown" }).label).toBe("Unknown");
  expect(shellState({ status: "stopped", exitCode: -1 })).toMatchObject({
    details: "Exit code: -1",
  });
});
