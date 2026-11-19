import type { MouseEvent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { SidebarNavAction } from "./SidebarHeaderActions";
import { Link } from "@/lib/routing";
import { cn } from "@/lib/utils";

export interface PrimaryNavLinkProps {
  to: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  componentId: string;
  testId?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  trailing?: ReactNode;
}

export function PrimaryNavLink({
  to,
  label,
  icon: Icon,
  active,
  componentId,
  testId,
  onClick,
  trailing,
}: PrimaryNavLinkProps) {
  return (
    <SidebarNavAction active={active} data-testid={testId}>
      <Link
        to={to}
        onClick={onClick}
        componentId={componentId}
        aria-current={active ? "page" : undefined}
      >
        <Icon
          className={cn(
            "ui-icon",
            active ? "text-[var(--sidebar-active-foreground)]" : "text-muted-foreground",
          )}
        />
        {label}
        {trailing}
      </Link>
    </SidebarNavAction>
  );
}
