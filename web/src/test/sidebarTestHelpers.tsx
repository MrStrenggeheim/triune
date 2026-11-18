// Modified for Triune.
/** Standard mounted Sidebar with a fresh query cache for each test. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarDataProvider } from "@/hooks/useSidebarData";
import { Sidebar } from "@/shell/Sidebar";

export function renderSidebar(
  props: { open?: boolean; onClose?: () => void; route?: string } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SidebarDataProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={[props.route ?? "/"]}>
            <Sidebar open={props.open ?? true} onClose={props.onClose ?? vi.fn()} />
          </MemoryRouter>
        </TooltipProvider>
      </SidebarDataProvider>
    </QueryClientProvider>,
  );
}

export function selectSessionsFromMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Session list actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Select sessions" }));
}
