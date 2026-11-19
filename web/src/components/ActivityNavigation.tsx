// Modified for Triune.
import type { ReactNode } from "react";
import { MessageCircleIcon, SquareTerminalIcon, WorkflowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/routing";

export function ActivityNavigation({
  name,
  shell = false,
  onOpen,
  onOrchestration,
  openHref,
  orchestrationHref,
}: {
  name: string;
  shell?: boolean;
  onOpen?: () => void;
  onOrchestration?: () => void;
  openHref?: string;
  orchestrationHref?: string;
}) {
  function navigation(icon: ReactNode, label: string, href?: string, action?: () => void) {
    if (!href && !action) return null;
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        asChild={!!href}
        onClick={href ? undefined : action}
      >
        {href ? (
          <Link
            to={href}
            onClick={(event) => {
              if (
                !action ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              action();
            }}
          >
            {icon}
          </Link>
        ) : (
          icon
        )}
      </Button>
    );
  }
  return (
    <>
      {navigation(
        shell ? (
          <SquareTerminalIcon aria-hidden="true" className="size-4" />
        ) : (
          <MessageCircleIcon aria-hidden="true" className="size-4" />
        ),
        `Open ${shell ? "shell" : "chat"} beside · ${name}`,
        openHref,
        onOpen,
      )}
      {navigation(
        <WorkflowIcon aria-hidden="true" className="size-4" />,
        `Show ${name} in Orchestration`,
        orchestrationHref,
        onOrchestration,
      )}
    </>
  );
}
