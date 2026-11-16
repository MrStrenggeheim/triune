// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageSquareIcon } from "lucide-react";
import { expect, it, vi } from "vitest";
import { OpenViewMenu } from "./OpenViewMenu";

it("opens the shared pane menu under external control and retains captured selection", () => {
  const run = vi.fn();
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  const action = { id: "new-chat", label: "New chat", icon: MessageSquareIcon, run };
  const menu = (open: boolean) => (
    <OpenViewMenu actions={[action]} open={open} onOpenChange={onOpenChange} onSelect={onSelect}>
      <button type="button">Pane plus</button>
    </OpenViewMenu>
  );
  const { rerender } = render(menu(false));
  expect(screen.queryByRole("menuitem", { name: "New chat" })).not.toBeInTheDocument();
  rerender(menu(true));
  fireEvent.click(screen.getByRole("menuitem", { name: "New chat" }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(action);
  expect(run).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
