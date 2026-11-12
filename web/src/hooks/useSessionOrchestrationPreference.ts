import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useViewerId } from "@/hooks/useViewerId";
import { getOmnigentHostConfig, getOmnigentServerIdentity } from "@/lib/host";
import { authenticatedFetch, getCurrentUserId } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";

interface SessionOrchestrationPreference {
  enabled: boolean;
  server_enabled: boolean;
}

const PATH = "/v1/preferences/session-orchestration";

async function readPreference(response: Response): Promise<SessionOrchestrationPreference> {
  if (!response.ok) throw await apiErrorFromResponse(response);
  const data = await response.json();
  if (typeof data?.enabled !== "boolean" || typeof data?.server_enabled !== "boolean") {
    throw new Error("Invalid agent communication preference response");
  }
  return { enabled: data.enabled, server_enabled: data.server_enabled };
}

export function useSessionOrchestrationPreference() {
  const accountId = useViewerId();
  const serverId = getOmnigentServerIdentity();
  const fetcher = getOmnigentHostConfig().fetcher;
  const queryClient = useQueryClient();
  const client = useMemo(() => {
    const queryKey = ["session-orchestration-preference", serverId, accountId] as const;
    return {
      queryKey,
      fetch: (init?: RequestInit) => {
        // Embedded transports own auth; retain the originating server's transport.
        // Standalone auth reads global state, so reject a superseded scope first.
        if (
          !fetcher &&
          (getOmnigentServerIdentity() !== serverId || getCurrentUserId() !== accountId)
        ) {
          throw new Error("Server or account changed. Reload the preference and try again.");
        }
        const headers = new Headers(init?.headers);
        if (accountId && accountId !== "local") headers.set("X-Forwarded-Email", accountId);
        return (fetcher ?? authenticatedFetch)(PATH, { ...init, headers, cache: "no-store" });
      },
    };
  }, [accountId, serverId, fetcher]);
  const mutation = useMutation({
    mutationFn: async (request: { enabled: boolean; client: typeof client }) => {
      await queryClient.cancelQueries({ queryKey: request.client.queryKey, exact: true });
      return readPreference(
        await request.client.fetch({
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: request.enabled }),
        }),
      );
    },
    onSuccess: (data, request) => {
      queryClient.setQueryData(request.client.queryKey, data);
    },
  });
  const currentMutation =
    mutation.variables?.client.queryKey[1] === serverId &&
    mutation.variables?.client.queryKey[2] === accountId;
  const isSaving = currentMutation && mutation.isPending;
  const query = useQuery({
    queryKey: client.queryKey,
    queryFn: async ({ signal }) => {
      const response = await client.fetch({ signal });
      // Older servers do not expose this preference; omit the control there.
      return response.status === 404 ? null : readPreference(response);
    },
    enabled: !!accountId && !!serverId && !isSaving,
    staleTime: 5_000,
    retry: false,
  });

  return {
    ...query,
    isSaving,
    saveError: currentMutation ? mutation.error : null,
    save: (enabled: boolean) => mutation.mutate({ enabled, client }),
  };
}
