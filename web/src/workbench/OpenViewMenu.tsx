// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import type { ReactElement } from "react";
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
}: {
  actions: WorkbenchOpenAction[];
  children: ReactElement;
  onSelect?: (action: WorkbenchOpenAction) => void;
}) {
  return (
    <DropdownMenu>
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
