// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import type { ComponentProps, ReactElement } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkbenchOpenAction } from "./WorkbenchAppBar";

/** Application, pane and empty-state entry points share one menu. */
export function OpenViewMenu({
  actions,
  children,
  onSelect,
  open,
  onOpenChange,
}: {
  actions: WorkbenchOpenAction[];
  children: ReactElement;
  onSelect?: (action: WorkbenchOpenAction) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Open view</DropdownMenuLabel>
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            disabled={action.disabled}
            onSelect={() => (onSelect ? onSelect(action) : action.run())}
          >
            <action.icon className="size-4" />
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EmptyDockPane(props: Omit<ComponentProps<typeof OpenViewMenu>, "children">) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-xl text-muted-foreground">Open a chat or tool to get started.</p>
      <OpenViewMenu {...props}>
        <Button variant="default">
          <PlusIcon className="size-4" />
          Open view
        </Button>
      </OpenViewMenu>
    </div>
  );
}
