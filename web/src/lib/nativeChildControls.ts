// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";

export interface NativeChildCapabilities {
  version: 1;
  state: string;
  can_reply: boolean;
  can_steer: boolean;
  can_stop: boolean;
  reason?: string | null;
  reasons?: { reply?: string | null; steer?: string | null; stop?: string | null };
  active_turn_id?: string | null;
}

export async function getNativeChildCapabilities(
  id: string,
  signal?: AbortSignal,
): Promise<NativeChildCapabilities> {
  const response = await authenticatedFetch(
    `/v1/sessions/${encodeURIComponent(id)}/native-child-capabilities`,
    { signal },
  );
  if (!response.ok) throw await apiErrorFromResponse(response);
  const result = await response.json();
  if (
    result.version !== 1 ||
    [result.can_reply, result.can_steer, result.can_stop].some(
      (value) => typeof value !== "boolean",
    )
  )
    throw new Error("Sub-agent controls are unavailable");
  return result;
}

export function nativeChildReadOnlyReason(
  capabilities?: NativeChildCapabilities | null,
): string | null {
  if (capabilities?.can_reply || capabilities?.can_steer) return null;
  if (!capabilities) return "Checking whether this sub-agent can receive messages…";
  switch (capabilities.reason) {
    case "parent_runtime_unavailable":
    case "parent_control_unavailable":
    case "native_child_runtime_lost":
    case "native_child_not_loaded":
      return "This sub-agent's original runtime is unavailable; its history remains readable";
    case "native_v2_targeted_input_unavailable":
      return "This native sub-agent supports messages from its parent agent only";
    default:
      return "This sub-agent does not support direct messages in its current runtime";
  }
}
