// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RuntimeNoticeIndicator } from "./RuntimeNoticeIndicator";

afterEach(cleanup);

it("opens notices above the trigger and dismisses each notice from its heading action", async () => {
  const onDismiss = vi.fn();
  const notice = {
    id: "usage",
    severity: "warning" as const,
    title: "Usage limit",
    message: "The current session has reached its usage limit.",
    created_at: 1_700_000_000,
  };
  render(
    <TooltipProvider>
      <RuntimeNoticeIndicator conversationId="session-1" notices={[notice]} onDismiss={onDismiss} />
    </TooltipProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Notices: 1" }));
  const popover = await screen.findByRole("dialog", { name: "Agent notices" });
  expect(popover).toHaveAttribute("data-side", "top");
  expect(within(popover).getByText("Usage limit")).toBeInTheDocument();
  fireEvent.click(within(popover).getByRole("button", { name: "Dismiss Usage limit" }));
  expect(onDismiss).toHaveBeenCalledWith(notice);
});
