import { authenticatedFetch } from "./identity";
import { apiErrorFromResponse } from "./sessionsApi";
import { z } from "zod";

const mode = z.enum(["manual", "automatic_idle"]);
const status = z.object({
  status: z.enum([
    "unknown",
    "checking",
    "up_to_date",
    "offline",
    "available",
    "unsupported",
    "installing",
    "failed",
  ]),
  mode,
  current_release: z.string().nullable(),
  release: z.string().nullable(),
  release_notes: z.string().nullish(),
  detail: z.string(),
  can_install: z.boolean(),
  automatic_idle_supported: z.boolean().optional(),
});

export type ServerUpdate = z.infer<typeof status>;
export type UpdateRequest =
  | { action: "check" }
  | { action: "install"; release: string }
  | { action: "mode"; mode: ServerUpdate["mode"] };

export async function fetchServerUpdate(
  request?: UpdateRequest,
  signal?: AbortSignal,
): Promise<ServerUpdate> {
  const path = "/api/server-update" + (request ? "/" + request.action : "");
  const body =
    request?.action === "mode"
      ? { mode: request.mode }
      : request?.action === "install"
        ? { release: request.release }
        : undefined;
  const response = await authenticatedFetch(path, {
    method: request?.action === "mode" ? "PUT" : request ? "POST" : "GET",
    cache: "no-store",
    signal,
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return status.parse(await response.json());
}
