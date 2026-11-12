// Modified for Triune.
import { PlusIcon, SearchIcon, SettingsIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeaderActionButton } from "@/components/HeaderActionButton";
import { MOD_KEY } from "@/components/KeyboardShortcut";
import { NotificationBell } from "@/components/NotificationCenter";
import { OpenViewMenu } from "./OpenViewMenu";
import { useLayoutEffect, useRef, useState } from "react";
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
  const bar = useRef<HTMLElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const [searchWidth, setSearchWidth] = useState(160);
  useLayoutEffect(() => {
    const measure = () => {
      const bounds = bar.current?.getBoundingClientRect();
      const a = left.current?.getBoundingClientRect();
      const b = right.current?.getBoundingClientRect();
      if (!bounds || !a || !b) return;
      const reservation = Math.max(a.right - bounds.left, bounds.right - b.left) + 12;
      setSearchWidth(Math.max(28, Math.min(480, bounds.width - reservation * 2)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [bar.current, left.current, right.current])
      if (element) observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <header
      className="workbench-app-bar relative flex h-9 min-h-9 shrink-0 items-center gap-2 border-b bg-sidebar px-2"
      ref={bar}
      aria-label="Application"
    >
      <div ref={left} className="flex min-w-0 items-center gap-2">
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
        className="absolute left-1/2 h-7 min-w-0 -translate-x-1/2 justify-start gap-2 px-2 text-muted-foreground"
        style={{ width: searchWidth }}
        aria-label="Search or run a command"
        data-workbench-search
      >
        <SearchIcon className="size-3.5" />
        <span className="min-w-0 truncate">Search or run a command…</span>
      </Button>
      <div ref={right} className="ml-auto flex shrink-0 items-center gap-2 max-md:gap-1">
        <OpenViewMenu actions={openActions}>
          <Button
            variant="default"
            size="sm"
            className="h-8 gap-1.5 px-4 text-primary-foreground max-md:px-2"
            aria-label="Open view"
          >
            <PlusIcon className="size-4" />
            <span className="hidden md:inline">Open view</span>
          </Button>
        </OpenViewMenu>
        <span className="hidden w-2 md:block" aria-hidden />
        <NotificationBell />
        <HeaderActionButton aria-label="Settings" onClick={onSettings}>
          <SettingsIcon className="size-4" />
        </HeaderActionButton>
      </div>
    </header>
  );
}
