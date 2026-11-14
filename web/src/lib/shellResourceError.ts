// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { ApiError } from "@/lib/sessionsApi";

/** Resource errors retain diagnostics on the server, not in message surfaces. */
export function shellResourceErrorMessage(
  error: unknown,
  fallback = "Could not refresh shell history. Try again.",
): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 401) return "Sign in again to access shell history.";
  if (error.status === 403) return "You do not have access to this shell.";
  if (error.status === 404) return "This shell is no longer available.";
  if (error.status === 409 || error.status === 410)
    return "Live shell controls are unavailable. Refresh to check the session.";
  if (error.status === 502 || error.status === 503 || error.status === 504)
    return "The host is unavailable. Captured output can still be viewed.";
  return fallback;
}
