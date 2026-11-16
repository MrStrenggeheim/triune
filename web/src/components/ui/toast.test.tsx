// Modified for Triune.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  vi.restoreAllMocks();
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
  it("consumes decaying previews into history without shortening expiry or resurfacing on close", async () => {
    mount();
    const onAutoClose = vi.fn();
    let id!: string | number;
    act(() => {
      id = toast("New saved record", { duration: 6000, onAutoClose });
    });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    fireEvent.pointerEnter(screen.getByText("New saved record").closest("article")!);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const history = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(history).getByText("New saved record")).toBeInTheDocument();
    expect(document.querySelectorAll(`[data-notification-id="${id}"]`)).toHaveLength(1);
    expect(getNotificationSnapshot().entries[0]).toMatchObject({
      id,
      visible: true,
      previewSuppressed: true,
      unread: false,
    });
    expect(onAutoClose).not.toHaveBeenCalled();
    act(() => toast("Arrived in feed"));
    expect(within(history).getByText("Arrived in feed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    expect(screen.queryByText("New saved record")).toBeNull();
    expect(screen.queryByText("Arrived in feed")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(4100));
    expect(onAutoClose).toHaveBeenCalledOnce();
    expect(getNotificationSnapshot().entries.find((entry) => entry.id === id)).toMatchObject({
      visible: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("New saved record")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    expect(screen.queryByText("New saved record")).toBeNull();
    act(() => toast("Explicit new reveal", { id }));
    expect(screen.getByText("Explicit new reveal")).toBeInTheDocument();
  });

  it("keeps required prompts, active cancellation and Undo usable when previews move into the feed", async () => {
    mount();
    const cancel = vi.fn();
    const undo = vi.fn();
    act(() => {
      toast.custom(() => <button>Required permission</button>, {
        id: "required",
        dismissible: false,
      });
      notify({
        id: "transfer",
        title: "Upload active",
        progress: { active: true, value: 30 },
        cancel: { label: "Cancel upload", onClick: cancel },
      });
      toast("Archived", { action: { label: "Undo", onClick: undo } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("button", { name: "Required permission" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    await waitFor(() => {
      expect(undo).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    });
    fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    expect(screen.getByRole("button", { name: "Required permission" })).toBeInTheDocument();
    expect(getNotificationSnapshot().entries.some((entry) => entry.id === "required")).toBe(true);
    expect(screen.queryByText("Upload active")).toBeNull();
  });

  it("anchors one preview viewport to the topmost rightmost visible bell and uses the exact feed width", async () => {
    let hidden = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.hasAttribute("data-notification-bell")) return new DOMRect();
      const place =
        this.parentElement?.closest<HTMLElement>("[data-bell-position]")?.dataset.bellPosition;
      if (place === "inert") return new DOMRect(990, 0, 24, 24);
      return place === "hidden" || (hidden && place === "right")
        ? new DOMRect()
        : new DOMRect(place === "right" ? 950 : 600, place === "lower" ? 80 : 8, 24, 24);
    });
    function Layout({ width }: { width: number }) {
      return (
        <NotificationLayoutProvider width={width} bottom="16px">
          <div data-bell-position="hidden" hidden>
            <NotificationBell />
          </div>
          <div data-bell-position="inert" ref={(node) => node?.setAttribute("inert", "")}>
            <NotificationBell />
          </div>
          <div data-bell-position="lower">
            <NotificationBell />
          </div>
          <div data-bell-position="left">
            <NotificationBell />
          </div>
          <div data-bell-position="right">
            <NotificationBell />
          </div>
          <Toaster />
        </NotificationLayoutProvider>
      );
    }
    const view = render(<Layout width={371} />);
    act(() => toast("Anchored preview"));
    const preview = screen.getByRole("region", { name: "Notifications" });
    expect(preview.style.top).toContain("44px");
    expect(preview.style.right).toContain("50px");
    expect(preview).toHaveStyle({ width: "371px" });
    expect(document.querySelectorAll("aside[aria-label=Notifications]")).toHaveLength(1);
    view.rerender(<Layout width={289} />);
    expect(preview).toHaveStyle({ width: "289px" });
    const bells = screen.getAllByRole("button", { name: "Notifications" });
    fireEvent.click(bells[bells.length - 1]);
    expect(screen.getByRole("dialog", { name: "Notifications" })).toHaveStyle({ width: "289px" });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    // A retained header becoming hidden releases its open-center ownership.
    act(() => {
      hidden = true;
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(getNotificationSnapshot().centerOpen).toBe(false);
    act(() => toast("After owner hides"));
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent(
      "After owner hides",
    );
    expect(preview.style.right).toContain("400px");
  });

  it.each([
    { name: "comfortable", height: 48, target: 24, gap: 12.5 },
    { name: "compact", height: 36, target: 24, gap: 6.5 },
    { name: "coarse", height: 48, target: 44, gap: 12.5 },
  ])(
    "mirrors the painted header inset for $name notification previews and history",
    async ({ height, target, gap }) => {
      let rowTop = 100;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.hasAttribute("data-notification-test-header"))
          return new DOMRect(0, rowTop, 600, height);
        if (this.hasAttribute("data-notification-bell"))
          return new DOMRect(550, rowTop + (height - target - 1) / 2, target, target);
        if (
          this.hasAttribute("data-header-action-surface") &&
          this.closest("[data-notification-bell]")
        )
          return new DOMRect(550 + (target - 24) / 2, rowTop + (height - 25) / 2, 24, 24);
        return new DOMRect();
      });
      render(
        <NotificationLayoutProvider width={320} bottom="16px">
          <div className="workspace-control-header" data-notification-test-header>
            <NotificationBell />
          </div>
          <Toaster />
        </NotificationLayoutProvider>,
      );
      act(() => toast("Retained geometry notice"));
      const preview = screen.getByRole("region", { name: "Notifications" });
      const top = rowTop + height + gap;
      expect(preview.style.top).toContain(`${top}px`);
      expect(preview.style.maxHeight).toContain(`${top}px`);
      expect(preview).toHaveStyle({ width: "320px" });
      await act(async () => {
        rowTop += 20;
        document
          .querySelector("[data-notification-test-header]")!
          .setAttribute("data-list-density", "compact");
      });
      expect(preview.style.top).toContain(`${top + 20}px`);
      fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
      const history = screen.getByRole("dialog", { name: "Notifications" });
      expect(history).toHaveAttribute("data-align", "end");
      expect(history).toHaveAttribute("data-popup-row-anchor", "true");
      expect(history).toHaveStyle({ width: "320px" });
      expect(within(history).getByText("Retained geometry notice")).toBeInTheDocument();
      fireEvent.click(within(history).getByRole("button", { name: "Close notifications" }));
      expect(
        getNotificationSnapshot().entries.some(
          (entry) => entry.title === "Retained geometry notice",
        ),
      ).toBe(true);
    },
  );

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
    expect(normal.closest("aside")).toHaveStyle({ width: "320px" });
    expect(normal.closest("aside")!.style.maxWidth).toContain("--omnigent-safe-left");
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByTestId("ordinary")).toHaveClass("density-row");
    expect(screen.getByTestId("activity")).toHaveClass("density-row");
    fireEvent.click(screen.getByRole("button", { name: "Clear completed notifications" }));
    expect(screen.queryByText("Project saved")).toBeNull();
    expect(screen.getByText("Uploading files")).toBeInTheDocument();
  });
});
