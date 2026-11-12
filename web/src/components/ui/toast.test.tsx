// Modified for Triune.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  toast,
  getNotificationSnapshot,
  setNotificationCenterOpen,
  setShowReadNotifications,
  notify,
  updateNotification,
} from "@/lib/notifications";
import { NotificationBell, NotificationLayoutProvider } from "@/components/NotificationCenter";
import { TooltipProvider } from "./tooltip";
import { Toaster } from "./sonner";
import { showToast } from "./toast";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  toast.dismiss();
  setNotificationCenterOpen(false);
  setShowReadNotifications(true);
});
afterEach(() => {
  act(() => {
    toast.dismiss();
    setNotificationCenterOpen(false);
  });
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});
function mount() {
  return render(
    <TooltipProvider>
      <NotificationLayoutProvider width={320} bottom="16px">
        <NotificationBell />
        <Toaster />
      </NotificationLayoutProvider>
    </TooltipProvider>,
  );
}

describe("shared notifications", () => {
  it("filters previously read entries while retaining newly seen notices and recovery actions", async () => {
    mount();
    const retry = vi.fn();
    act(() => {
      toast("Previously read");
      toast.error("Retry available", { action: { label: "Retry", onClick: retry } });
      toast("Open archive", { cancel: { label: "View archived", onClick: vi.fn() } });
      notify({ title: "Still uploading", progress: { active: true, value: 25 } });
      toast.loading("Still loading");
      toast.custom(() => <button type="button">Allow access</button>, { dismissible: false });
      setNotificationCenterOpen(true);
      setNotificationCenterOpen(false);
      toast("Newly arrived");
    });
    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(bell).toHaveAttribute("aria-description", "1 unread, 2 activities in progress");
    fireEvent.click(bell);
    const toggle = screen.getByRole("button", { name: "Show read notifications" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Previously read")).toBeNull();
    for (const title of ["Newly arrived", "Retry available", "Still uploading", "Still loading"])
      expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View archived" })).toBeInTheDocument();
    expect(bell).toHaveAttribute("aria-description", "0 unread, 2 activities in progress");
    act(() => toast("Arrived while reading"));
    expect(screen.getByText("Arrived while reading")).toBeInTheDocument();
    expect(getNotificationSnapshot().entries.every((entry) => !entry.unread)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(screen.queryByText("Retry available")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Previously read")).toBeInTheDocument();
    expect(screen.getByText("Retry available")).toBeInTheDocument();
  });

  it("keeps the filter across visits, with a useful empty state and accurate unread count", () => {
    mount();
    act(() => toast("Seen once"));
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Show read notifications" }));
    expect(screen.getByText("Seen once")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("button", { name: "Show read notifications" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByText("Seen once")).toBeNull();
    expect(screen.getByText("No unread notifications")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    act(() => toast("Still unread"));
    expect(screen.getByText("Still unread")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notifications" })).toHaveAttribute(
      "aria-description",
      "1 unread, 0 activities in progress",
    );
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("Still unread")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear completed notifications" }));
    expect(getNotificationSnapshot().entries).toHaveLength(0);
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
  });

  it("keeps pending notification actions visible until they complete", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mount();
    act(() => {
      toast("Restore pending", { action: { label: "Restore", onClick: () => pending } });
      setNotificationCenterOpen(true);
      setNotificationCenterOpen(false);
      setShowReadNotifications(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const id = getNotificationSnapshot().entries[0].id;
    act(() => updateNotification(id, { action: undefined }));
    expect(screen.getByText("Restore pending")).toBeInTheDocument();
    await act(async () => finish());
    expect(screen.queryByText("Restore pending")).toBeNull();
  });

  it("opens only one center when existing headers share the bell", () => {
    render(
      <NotificationLayoutProvider width={320} bottom="16px">
        <NotificationBell />
        <NotificationBell />
        <Toaster />
      </NotificationLayoutProvider>,
    );
    const bells = screen.getAllByRole("button", { name: "Notifications" });
    fireEvent.click(bells[0]);
    expect(screen.getAllByRole("dialog", { name: "Notifications" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show read notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    fireEvent.click(bells[1]);
    expect(screen.getAllByRole("dialog", { name: "Notifications" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Show read notifications" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("renders nothing until a notification is shown", () => {
    render(<Toaster />);
    expect(document.querySelector("[data-notification-card]")).toBeNull();
  });

  it("hides compatibility content without deleting its history", async () => {
    mount();
    act(() => showToast(<span>Hello there</span>, { duration: 0 }));
    expect(await screen.findByTestId("toast")).toHaveTextContent("Hello there");
    fireEvent.click(screen.getByRole("button", { name: "Hide notification" }));
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(getNotificationSnapshot().entries).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toHaveTextContent(
      "Hello there",
    );
  });

  it("retains working actions after a popup automatically collapses", async () => {
    mount();
    const undo = vi.fn();
    act(() =>
      toast.success("Archived project", {
        description: "Research",
        action: { label: "Undo", onClick: undo },
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(10_001));
    expect(screen.queryByText("Archived project")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toHaveTextContent(
      "Research",
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("pauses while hovered and retains required prompts above recent notices", async () => {
    mount();
    act(() =>
      toast.custom(() => <button type="button">Allow copying</button>, {
        id: "permission",
        dismissible: false,
        duration: Infinity,
      }),
    );
    act(() => toast("Read this", { testId: "read" }));
    fireEvent.pointerEnter(await screen.findByTestId("read"));
    await act(() => vi.advanceTimersByTimeAsync(11_000));
    expect(screen.getByTestId("read")).toBeInTheDocument();
    fireEvent.pointerLeave(screen.getByTestId("read"));
    await act(() => vi.advanceTimersByTimeAsync(10_001));
    expect(screen.queryByTestId("read")).toBeNull();
    act(() => {
      for (let index = 0; index < 5; index++) toast(`Notice ${index}`);
    });
    expect(screen.getByRole("button", { name: "Allow copying" })).toBeInTheDocument();
    expect(screen.getByText("Notice 4")).toBeInTheDocument();
    expect(screen.queryByText("Notice 0")).toBeNull();
    expect(document.querySelectorAll("[data-notification-card]")).toHaveLength(4);
  });

  it("uses the same card and width for activity and ordinary messages", () => {
    mount();
    act(() => {
      toast("Project saved", { testId: "ordinary" });
      notify({
        title: "Uploading files",
        testId: "activity",
        progress: { active: true, value: 25, label: "25%" },
      });
    });
    const normal = screen.getByTestId("ordinary");
    const progress = screen.getByTestId("activity");
    expect(normal.className).toBe(progress.className);
    expect(normal).toHaveClass("density-row");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(normal.closest("aside")).toHaveStyle({ width: "320px", maxWidth: "calc(100vw - 2rem)" });
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByTestId("ordinary")).toHaveClass("density-row");
    expect(screen.getByTestId("activity")).toHaveClass("density-row");
    fireEvent.click(screen.getByRole("button", { name: "Clear completed notifications" }));
    expect(screen.queryByText("Project saved")).toBeNull();
    expect(screen.getByText("Uploading files")).toBeInTheDocument();
  });
});
