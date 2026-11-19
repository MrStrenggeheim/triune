import { HeaderActionButton } from "@/components/HeaderActionButton";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useMarkArcaBannerWhenVisible } from "@/hooks/useArcaShutdownBanner";
import { offersWorkweek } from "@/lib/arcaShutdownWarning";
import { copyText } from "@/lib/clipboard";
import { useNotificationNotice } from "@/hooks/useNotificationNotice";
import { toast } from "@/lib/notifications";
import { ArcaExtendActions, useCanExtendArca } from "./ArcaExtendActions";

function CommandCopyButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimeout.current) clearTimeout(resetTimeout.current);
    };
  }, []);

  const copy = async () => {
    try {
      await copyText(command);
      setCopied(true);
      if (resetTimeout.current) clearTimeout(resetTimeout.current);
      resetTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error("Could not copy command", {
        description: error instanceof Error ? error.message : String(error),
      });
      setCopied(false);
    }
  };

  return (
    <div className="flex max-w-full items-center gap-1 rounded border border-border bg-background/70 px-2 py-0.5">
      <code className="min-w-0 break-all">{command}</code>
      <HeaderActionButton
        type="button"
        aria-label={`Copy ${command}`}
        tooltip={copied ? "Copied" : `Copy ${command}`}
        onClick={() => void copy()}
      >
        {copied ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <CopyIcon className="size-3.5" aria-hidden="true" />
        )}
      </HeaderActionButton>
      <span role="status" className="sr-only">
        {copied ? "Command copied" : ""}
      </span>
    </div>
  );
}

export function ArcaShutdownBanner({
  warning,
}: {
  warning: { day: string; dismissToday: () => void };
  hasTasks?: boolean;
}) {
  useMarkArcaBannerWhenVisible(warning.day);
  const commands = ["arca extend overnight"];
  if (offersWorkweek(new Date(`${warning.day}T12:00:00`))) commands.push("arca extend workweek");
  const desktopExtend = useCanExtendArca();
  const copyCommands = (
    <div className="flex flex-wrap gap-2">
      {commands.map((command) => (
        <CommandCopyButton key={command} command={command} />
      ))}
    </div>
  );

  useNotificationNotice(`arca-shutdown:${warning.day}`, {
    title: "Your Arca will shut down at about 6 PM unless you keep it running.",
    type: "warning",
    description: "Extend it from your laptop to keep it running.",
    jsx: (
      <>
        {desktopExtend && (
          <ArcaExtendActions
            day={warning.day}
            onSuccess={warning.dismissToday}
            fallback={() => copyCommands}
          />
        )}
        {desktopExtend === false && (
          <>
            {copyCommands}
            <p>Run this on your laptop. Already extended? You can ignore this.</p>
          </>
        )}
      </>
    ),
    cancel: { label: "Not now", onClick: warning.dismissToday },
  });
  return null;
}
