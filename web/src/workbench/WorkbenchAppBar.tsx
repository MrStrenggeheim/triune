// Modified for Triune.
import { PlusIcon, SearchIcon, SettingsIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeaderActionButton } from "@/components/HeaderActionButton";
import { MOD_KEY } from "@/components/KeyboardShortcut";
import { NotificationBell } from "@/components/NotificationCenter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BrandLogo } from "@/components/BrandLogo";
import { useAppName } from "@/lib/branding";
import { SidebarToggle } from "@/shell/SidebarToggle";

export interface WorkbenchOpenAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  disabled?: boolean;
}

export function WorkbenchAppBar({
  sidebarOpen,
  onToggleSidebar,
  onSearch,
  onSettings,
  openActions,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSearch: () => void;
  onSettings: () => void;
  openActions: WorkbenchOpenAction[];
}) {
  const appName = useAppName();
  return (
    <header
      className="workbench-app-bar relative flex h-9 min-h-9 shrink-0 items-center gap-2 border-b bg-sidebar px-2"
      aria-label="Application"
    >
      <div className="flex min-w-0 items-center gap-2">
        <SidebarToggle
          side="left"
          expanded={sidebarOpen}
          aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
          tooltipShortcut={[MOD_KEY, "B"]}
          onClick={onToggleSidebar}
        />
        <BrandLogo className="size-7 shrink-0" />
        <span className="hidden text-base font-bold sm:block">{appName}</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onSearch}
        className="absolute left-1/2 h-6 min-w-0 -translate-x-1/2 gap-2 text-muted-foreground max-md:size-11 max-md:p-0 md:w-[min(34vw,30rem)] md:justify-start"
        aria-label="Search or run a command"
        data-workbench-search
      >
        <SearchIcon className="size-3.5" />
        <span className="hidden truncate md:block">Search or run a command…</span>
      </Button>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="default"
              size="sm"
              className="h-8 gap-1.5 px-4 text-primary-foreground max-md:h-11"
              aria-label="Open view"
            >
              <PlusIcon className="size-4" />
              <span className="hidden md:inline">Open</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Open</DropdownMenuLabel>
            {openActions.map((action) => (
              <DropdownMenuItem key={action.id} disabled={action.disabled} onSelect={action.run}>
                <action.icon className="size-4" />
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <NotificationBell />
        <HeaderActionButton aria-label="Settings" onClick={onSettings}>
          <SettingsIcon className="size-4" />
        </HeaderActionButton>
      </div>
    </header>
  );
}
