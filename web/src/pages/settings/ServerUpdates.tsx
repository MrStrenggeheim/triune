import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { onlineManager, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useViewerId } from "@/hooks/useViewerId";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { getOmnigentServerIdentity } from "@/lib/host";
import { ApiError } from "@/lib/sessionsApi";
import { fetchServerUpdate, type ServerUpdate, type UpdateRequest } from "@/lib/serverUpdateApi";
import { SettingsGroup } from "@/components/SettingsGroup";
import { SettingsLabel } from "@/components/SettingsLabel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ServerUpdateDialog } from "./ServerUpdateDialog";

const messages: Record<ServerUpdate["status"], string> = {
  unknown: "Update availability is unknown.",
  checking: "Checking for releases…",
  up_to_date: "The server is up to date.",
  offline: "Could not reach the release service.",
  available: "A server update is available.",
  unsupported: "Server updates are unavailable on this deployment.",
  installing: "Installing the update. Waiting for the server to reconnect…",
  failed: "The update failed.",
};

interface UpdateControls {
  data: ServerUpdate;
  busy: boolean;
  disconnected: boolean;
  error: string | null;
  review: () => void;
  submit: (request: UpdateRequest) => void;
  refresh: () => void;
}

const UpdateContext = createContext<UpdateControls | null>(null);
function eligibleRelease(data: ServerUpdate | undefined) {
  return data?.can_install && (data.status === "available" || data.status === "failed")
    ? data.release
    : null;
}
const subscribeOnline = (notify: () => void) => onlineManager.subscribe(notify);
const isOnline = () => onlineManager.isOnline();

export function ServerUpdatesProvider({ children }: { children: ReactNode }) {
  const info = useServerInfo();
  const admin = useIsAdmin();
  const viewer = useViewerId();
  const server = getOmnigentServerIdentity();
  const online = useSyncExternalStore(subscribeOnline, isOnline, isOnline);
  const enabled = !!(
    admin &&
    viewer &&
    server &&
    info !== "loading" &&
    info.capabilities?.server_update
  );
  const queryKey = useMemo(() => ["server-update", server, viewer], [server, viewer]);
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: ({ signal }) => fetchServerUpdate(undefined, signal),
    retry: false,
    refetchInterval: ({ state }) =>
      state.data?.status === "checking" || state.data?.status === "installing" ? 2500 : false,
  });
  const mutation = useMutation({
    onMutate: ({ key }) => client.cancelQueries({ queryKey: key, exact: true }),
    mutationFn: async ({ request }: { request: UpdateRequest; key: typeof queryKey }) =>
      fetchServerUpdate(request),
    onSuccess: (data, { key, request }) => {
      client.setQueryData(key, data);
      if (request.action === "install") setReviewing(null);
    },
    onError: (_error, { key }) => {
      void client.invalidateQueries({ queryKey: key, exact: true });
    },
    retry: false,
    networkMode: "always",
  });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
  const data = enabled && !denied ? query.data : undefined;
  const releaseKey = JSON.stringify([server, viewer, data?.release]);
  const release = eligibleRelease(data);
  const currentMutation =
    mutation.variables?.key[1] === server && mutation.variables?.key[2] === viewer;
  const busy = currentMutation && mutation.isPending;
  const disconnected = !online || query.isError || query.isPaused;
  const error = currentMutation && mutation.error ? mutation.error.message : null;
  const { mutate, reset } = mutation;
  const { refetch } = query;
  const submit = useCallback(
    (request: UpdateRequest) => {
      if (data && !busy && !disconnected) mutate({ request, key: queryKey });
    },
    [data, busy, disconnected, mutate, queryKey],
  );
  const value = useMemo<UpdateControls | null>(
    () =>
      data && data.status !== "unsupported"
        ? {
            data,
            busy,
            disconnected,
            error,
            submit,
            refresh: () => {
              void refetch();
            },
            review: () => {
              reset();
              setReviewing(releaseKey);
              setDismissed(null);
            },
          }
        : null,
    [data, busy, disconnected, error, submit, refetch, reset, releaseKey],
  );
  return (
    <UpdateContext.Provider value={value}>
      {children}
      {data &&
        release &&
        (data.status === "available" || reviewing === releaseKey) &&
        !disconnected &&
        dismissed !== releaseKey && (
          <ServerUpdateDialog
            installed={data.current_release}
            available={release}
            notes={data.release_notes ?? null}
            busy={busy}
            error={error ?? (data.status === "failed" ? data.detail || messages.failed : null)}
            onLater={() => {
              setDismissed(releaseKey);
              setReviewing(null);
            }}
            onInstall={() => {
              submit({ action: "install", release });
            }}
          />
        )}
    </UpdateContext.Provider>
  );
}

export function ServerUpdateSettings() {
  const controls = useContext(UpdateContext);
  if (!controls) return null;
  const { data, busy, disconnected, error, submit } = controls;
  const installing = data.status === "installing";
  return (
    <SettingsGroup title="Server updates" contentClassName="flex flex-col gap-4">
      <div aria-live="polite" className="text-ui">
        <p>{disconnected ? "Disconnected from the server." : messages[data.status]}</p>
        {!disconnected && data.detail && (
          <p className="break-words text-muted-foreground">{data.detail}</p>
        )}
        {data.current_release && (
          <p className="break-all text-muted-foreground">Installed: {data.current_release}</p>
        )}
        {eligibleRelease(data) && (
          <p className="break-all text-muted-foreground">Available: {data.release}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {eligibleRelease(data) && (
          <Button disabled={busy || disconnected} onClick={controls.review}>
            {data.status === "failed" ? "Review and retry" : "Review update"}
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy || (!disconnected && (installing || data.status === "checking"))}
          onClick={() => (disconnected ? controls.refresh() : submit({ action: "check" }))}
        >
          {disconnected ? "Reconnect" : "Check for updates"}
        </Button>
      </div>
      {data.automatic_idle_supported === true && (
        <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
          <SettingsLabel
            label="Install automatically when idle"
            description="Wait for active runs to finish before installing and restarting the server."
          />
          <Switch
            aria-label="Install automatically when idle"
            checked={data.mode === "automatic_idle"}
            disabled={busy || disconnected || installing}
            onCheckedChange={(checked) =>
              submit({ action: "mode", mode: checked ? "automatic_idle" : "manual" })
            }
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}
