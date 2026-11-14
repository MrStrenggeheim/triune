// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityRow } from "./ActivityRow";
import { SubagentTaskStatus } from "./blocks/SubagentTaskRow";
import { toast } from "@/lib/notifications";

vi.mock("@/lib/notifications", () => ({ toast: { error: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const row = (onStop?: () => Promise<void>, onOpen = vi.fn()) => (
  <ActivityRow
    icon={<span>Icon</span>}
    title="Exact resource"
    description="Recorded output"
    status={<SubagentTaskStatus status={{ activity: "working", label: "Running" }} />}
    onOpen={onOpen}
    onStop={onStop}
    actions={
      <button type="button" onClick={() => {}}>
        Open beside
      </button>
    }
  />
);

it("keeps actions outside the opening target and leaves unsupported status inert", () => {
  const open = vi.fn();
  render(row(undefined, open));
  fireEvent.click(screen.getByRole("button", { name: "Open beside" }));
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByRole("status", { name: "Running" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Actions/ })).toBeNull();
  fireEvent.click(screen.getByText("Recorded output"));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.getByText("Recorded output")).toHaveClass("truncate");
  expect(screen.getByRole("button", { name: "Exact resource" }).querySelector("button")).toBeNull();
});

it("opens Stop from the keyboard and prevents duplicate requests while pending", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  const stop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const open = vi.fn();
  render(row(stop, open));
  expect(
    screen
      .getByRole("button", { name: "Actions for Exact resource" })
      .querySelector(".resource-stop-label"),
  ).toHaveAttribute("data-slot", "badge");
  screen.getByRole("button", { name: "Actions for Exact resource" }).focus();
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("menuitem", { name: "Stop Exact resource" }));
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Actions for Exact resource" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Actions for Exact resource" }));
  expect(stop).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(screen.getByRole("button", { name: "Actions for Exact resource" })).toBeEnabled();
});

it("exposes the same Stop through row context access and keeps failures visible", async () => {
  const stop = vi.fn().mockRejectedValue(new Error("Resource disconnected"));
  render(row(stop));
  fireEvent.contextMenu(screen.getByText("Recorded output"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Stop Exact resource" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Resource disconnected"));
  expect(screen.getByText("Recorded output")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Actions for Exact resource" })).toBeEnabled();
});

it("opens a status menu on touch without stopping or navigating on the first tap", async () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn();
  render(row(stop, open));
  const status = screen.getByRole("button", { name: "Actions for Exact resource" });
  fireEvent.pointerDown(status, { pointerType: "touch", button: 0 });
  fireEvent.click(status, { detail: 1 });
  expect(stop).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Stop Exact resource" }));
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(open).not.toHaveBeenCalled();
});
