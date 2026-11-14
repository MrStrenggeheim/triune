// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import { ApiError } from "./sessionsApi";
import { shellResourceErrorMessage } from "./shellResourceError";

it.each([401, 403, 404, 409, 410, 422, 500, 502, 503, 504])(
  "keeps private routing diagnostics out of shell notices (%s)",
  (status) => {
    const message = shellResourceErrorMessage(
      new ApiError("runner_token_private chat_private", status, null),
    );
    expect(message).not.toMatch(/runner_token|chat_private/);
    expect(message).not.toBe("");
  },
);

it("gives unknown transport errors a safe retry action without exposing their content", () => {
  expect(
    shellResourceErrorMessage(new Error("private tunnel path"), "Could not stop this shell."),
  ).toBe("Could not stop this shell.");
});
