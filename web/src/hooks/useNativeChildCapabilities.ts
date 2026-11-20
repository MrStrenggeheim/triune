// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { useQuery } from "@tanstack/react-query";
import {
  getNativeChildCapabilities,
  type NativeChildCapabilities,
} from "@/lib/nativeChildControls";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import { RESOURCE_POLL_MS, usePollingInterval } from "./usePollingInterval";

export function useNativeChildCapabilities(
  id: string | null | undefined,
  active = true,
  initial?: NativeChildCapabilities | null,
) {
  const refetchInterval = usePollingInterval({
    active: Boolean(id) && active,
    intervalMs: RESOURCE_POLL_MS,
  });
  return useQuery({
    queryKey: ["native-child-capabilities", resourceViewStorageScope(), id],
    queryFn: ({ signal }) => getNativeChildCapabilities(id!, signal),
    enabled: Boolean(id) && active,
    initialData: initial ?? undefined,
    retry: false,
    staleTime: 2_000,
    refetchInterval,
  });
}
