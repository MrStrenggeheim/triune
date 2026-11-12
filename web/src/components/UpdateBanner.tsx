// Modified for Triune.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { type UpdateStatus, updateBridge } from "@/lib/nativeBridge";
import { NotificationCard } from "./NotificationCard";
import { useNotificationNotice } from "@/hooks/useNotificationNotice";
import {
  getNotificationSnapshot,
  subscribeNotifications,
  type NotifyInput,
} from "@/lib/notifications";

function statusVersion(status: UpdateStatus | null): string | null {
  return status?.info?.version ?? null;
}

function formatPercent(percent: number | undefined): number {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** Publish desktop updates; the native overlay can render the same card directly. */
export function UpdateBanner({ variant = "floating" }: { variant?: "floating" | "bare" } = {}) {
  const bridge = updateBridge();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [skippedVersion, setSkippedVersion] = useState<string | null | "loading">("loading");
  const [autoInstall, setAutoInstall] = useState(true);

  useEffect(() => {
    if (!bridge) return undefined;
    let alive = true;
    let unsubscribe: (() => void) | undefined;

    void bridge
      .getStatus()
      .then((currentStatus) => {
        if (!alive) return;
        setStatus(currentStatus);
        unsubscribe = bridge.onStatus((nextStatus) => {
          setStatus(nextStatus);
        });
        void bridge
          .getConfig()
          .then((config) => {
            if (alive) {
              setSkippedVersion(config.skippedVersion);
              setAutoInstall(config.autoInstall);
            }
          })
          .catch((err) => {
            console.warn("[UpdateBanner] update bridge config read failed:", err);
            if (alive) setSkippedVersion(null);
          });
      })
      .catch((err) => {
        console.warn("[UpdateBanner] update bridge status read failed:", err);
        if (alive) setSkippedVersion(null);
      });

    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [bridge]);

  const version = statusVersion(status);
  const hidden = skippedVersion === "loading" || (version !== null && version === skippedVersion);
  const visibleStatus = useMemo(() => {
    if (!status || hidden) return null;
    if (status.state === "idle" || status.state === "checking" || status.state === "none") {
      return null;
    }
    return status;
  }, [hidden, status]);

  const onDownload = useCallback(async () => {
    await bridge?.download();
  }, [bridge]);
  const onInstall = useCallback(async () => {
    await bridge?.installNow();
  }, [bridge]);
  const onSkip = useCallback(async () => {
    if (!bridge || !version) return;
    const next = await bridge.setConfig({ skippedVersion: version });
    setSkippedVersion(next.skippedVersion);
  }, [bridge, version]);
  const progress =
    visibleStatus?.state === "downloading"
      ? formatPercent(visibleStatus.progress?.percent)
      : undefined;
  const isError = visibleStatus?.state === "error-security";
  const input: NotifyInput | null = visibleStatus
    ? {
        title: isError
          ? "Update check failed"
          : visibleStatus.state === "downloading"
            ? `Downloading Triune Desktop update… ${progress}%`
            : visibleStatus.state === "downloaded"
              ? `Triune Desktop ${version ?? "update"} is ready to install`
              : `Triune Desktop ${version ?? "update"} is available`,
        type: isError ? "error" : "info",
        description: (
          <>
            {isError && visibleStatus.lastError && <p>{visibleStatus.lastError}</p>}
            {visibleStatus.state !== "downloading" && !isError && (
              <>
                {visibleStatus.currentVersion && (
                  <p>Current version: {visibleStatus.currentVersion}.</p>
                )}
                <p>Updating won’t interrupt existing sessions.</p>
                {autoInstall && visibleStatus.state === "downloaded" && (
                  <p>Installs automatically on next quit.</p>
                )}
              </>
            )}
            {visibleStatus.info?.releaseNotes && visibleStatus.state !== "downloading" && (
              <details>
                <summary className="cursor-pointer">Release notes</summary>
                <div className="max-h-32 overflow-auto whitespace-pre-wrap">
                  {visibleStatus.info.releaseNotes}
                </div>
              </details>
            )}
          </>
        ),
        progress:
          progress !== undefined
            ? { value: progress, active: true, label: "Update download progress" }
            : undefined,
        action:
          visibleStatus.state === "available"
            ? {
                label: "Update now",
                onClick: async (event) => {
                  event.preventDefault();
                  await onDownload();
                },
              }
            : visibleStatus.state === "downloaded"
              ? {
                  label: "Restart to update",
                  onClick: async (event) => {
                    event.preventDefault();
                    await onInstall();
                  },
                }
              : undefined,
        cancel:
          visibleStatus.state === "available"
            ? { label: "Skip this version", onClick: onSkip }
            : undefined,
      }
    : null;
  useNotificationNotice("desktop-update", input, visibleStatus?.state ?? "");
  return variant === "bare" ? <DesktopUpdateCard /> : null;
}

/** The native overlay has its own renderer, but uses the shared notification card. */
function DesktopUpdateCard() {
  const { entries } = useSyncExternalStore(
    subscribeNotifications,
    getNotificationSnapshot,
    getNotificationSnapshot,
  );
  const entry = entries.find((item) => item.id === "desktop-update" && item.visible);
  return entry ? (
    <div aria-label="Desktop update">
      <NotificationCard entry={entry} />
    </div>
  ) : null;
}
