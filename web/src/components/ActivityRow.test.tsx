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

it("joins navigation and disclosure with a stable body identity and keeps actions independent", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  const navigation = vi.fn();
  const view = (summary: string) => (
    <ActivityRow
      presentation="message"
      title={<strong>Ada · Audit</strong>}
      summary={summary}
      icon={<span>Icon</span>}
      onOpen={open}
      actions={
        <>
          <button type="button" onClick={navigation}>
            Open chat
          </button>
          <button type="button" onClick={navigation}>
            Workflow
          </button>
        </>
      }
    >
      <p>Exact captured body</p>
    </ActivityRow>
  );
  const rendered = render(view("Short excerpt"));
  const controls = screen.getAllByRole("button");
  expect(
    controls.map((control) => control.getAttribute("aria-label") ?? control.textContent),
  ).toEqual(["Ada · Audit", "Open chat", "Workflow", "Expand activity"]);
  const disclosure = screen.getByRole("button", { name: "Expand activity" });
  const id = disclosure.getAttribute("aria-controls")!;
  expect(document.getElementById(id)).not.toBeVisible();
  expect(screen.getByText("Short excerpt")).toBeVisible();
  disclosure.focus();
  await user.keyboard(" ");
  expect(document.getElementById(id)).toHaveTextContent("Exact captured body");
  expect(document.getElementById(id)).toBeVisible();
  expect(screen.queryByText("Short excerpt")).toBeNull();
  expect(open).not.toHaveBeenCalled();
  rendered.rerender(view("Updated excerpt"));
  expect(screen.queryByText("Updated excerpt")).toBeNull();
  expect(screen.getByRole("button", { name: "Collapse activity" })).toHaveAttribute(
    "aria-controls",
    id,
  );
  await user.click(screen.getByRole("button", { name: "Workflow" }));
  expect(navigation).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Collapse activity" }));
  expect(document.getElementById(id)).not.toBeVisible();
  expect(screen.getByText("Updated excerpt")).toBeVisible();
});

it("honors controlled expansion while retaining the same content identity", () => {
  const change = vi.fn();
  const view = (expanded: boolean) => (
    <ActivityRow
      presentation="message"
      icon={<span>Icon</span>}
      title="Controlled card"
      expanded={expanded}
      onExpandedChange={change}
    >
      <p>Captured detail</p>
    </ActivityRow>
  );
  const rendered = render(view(false));
  const disclosure = screen.getByRole("button", { name: "Expand activity" });
  const id = disclosure.getAttribute("aria-controls")!;
  fireEvent.click(disclosure);
  expect(change).toHaveBeenCalledWith(true);
  expect(document.getElementById(id)).not.toBeVisible();
  rendered.rerender(view(true));
  expect(screen.getByRole("button", { name: "Collapse activity" })).toHaveAttribute(
    "aria-controls",
    id,
  );
  expect(document.getElementById(id)).toHaveTextContent("Captured detail");
});

it("retains a resource summary during expansion", () => {
  render(
    <ActivityRow icon={<span>Icon</span>} title="Resource" description="Resource preview">
      <p>Resource output</p>
    </ActivityRow>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
  expect(screen.getByText("Resource preview")).toBeVisible();
  expect(screen.getByText("Resource output")).toBeVisible();
});
