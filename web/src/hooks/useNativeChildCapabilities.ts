// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { useQuery } from "@tanstack/react-query";
import {
  getNativeChildCapabilities,
  type NativeChildCapabilities,
} from "@/lib/nativeChildControls";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";

export function useNativeChildCapabilities(
  id: string | null | undefined,
  active = true,
  initial?: NativeChildCapabilities | null,
) {
  return useQuery({
    queryKey: ["native-child-capabilities", resourceViewStorageScope(), id],
    queryFn: ({ signal }) => getNativeChildCapabilities(id!, signal),
    enabled: Boolean(id) && active,
    initialData: initial ?? undefined,
    retry: false,
    staleTime: 2_000,
    refetchInterval: active ? 5_000 : false,
  });
}
