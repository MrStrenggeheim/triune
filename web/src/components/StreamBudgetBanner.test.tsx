// Modified for Triune.
import { getNotificationSnapshot, notify, removeNotification } from "@/lib/notifications";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StreamBudgetBanner } from "./StreamBudgetBanner";
import { useChatStore } from "@/store/chatStore";

afterEach(() => {
  cleanup();
  removeNotification("stream-budget");
  useChatStore.setState({ streamBudgetExceeded: false, streamBudgetBannerDismissed: false });
});

it("never publishes a capacity notice, even with a stale exceeded flag", () => {
  useChatStore.setState({ streamBudgetExceeded: true, streamBudgetBannerDismissed: false });
  render(<StreamBudgetBanner />);
  expect(getNotificationSnapshot().entries.some((entry) => entry.id === "stream-budget")).toBe(
    false,
  );
});

it("removes the capacity notice saved by an older app", () => {
  notify({ id: "stream-budget", title: "Conversation stream capacity", type: "warning" });
  expect(getNotificationSnapshot().entries.some((entry) => entry.id === "stream-budget")).toBe(
    true,
  );
  render(<StreamBudgetBanner />);
  expect(getNotificationSnapshot().entries.some((entry) => entry.id === "stream-budget")).toBe(
    false,
  );
});
