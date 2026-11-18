// Modified for Triune.
import { renderSidebar } from "@/test/sidebarTestHelpers";
import { conversation as conv, conversationPage } from "@/test/sidebarMockHelpers";
// Behaviour tests for the mobile sidebar drawer shape: it stops short of the
// right edge so a strip of the chat stays visible, tapping that strip dismisses
// it (replacing the collapse toggle, which is now desktop-only), and Settings stays in the footer.

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/hooks/useConversations";

vi.mock("@/hooks/useConversations", async () => {
  const { conversationHooksMock } = await import("@/test/sidebarMockHelpers");
  return conversationHooksMock();
});

vi.mock("@/components/PermissionsModal", () => ({ PermissionsModal: () => null }));

vi.mock("@/lib/serverOrigin", () => ({
  isCurrentServerLocal: () => false,
  isLocalServerOrigin: (origin: string) =>
    ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(new URL(origin).hostname),
}));

import { useConversations } from "@/hooks/useConversations";

const useConvMock = vi.mocked(useConversations);

function mockConversations(conversations: Conversation[]) {
  useConvMock.mockImplementation(() => conversationPage(conversations));
}

beforeEach(() => {
  mockConversations([conv("conv_a")]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("mobile sidebar drawer", () => {
  it("dismisses when the exposed strip of the chat is tapped", () => {
    const onClose = vi.fn();
    renderSidebar({ onClose });

    fireEvent.click(screen.getByTestId("sidebar-scrim"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the scrim inert while the drawer is closed", () => {
    renderSidebar({ open: false });

    const scrim = screen.getByTestId("sidebar-scrim");
    expect(scrim).toHaveClass("pointer-events-none", "opacity-0");
    // Untappable is not enough for a focusable control: parked, it must also
    // leave the tab order and the a11y tree. (Not `inert` — React 18 drops the
    // boolean form, so this would silently stay reachable.)
    expect(scrim).toHaveAttribute("tabindex", "-1");
    expect(scrim).toHaveAttribute("aria-hidden", "true");
  });

  it("exposes the dismiss as a labeled control, not a bare click target", () => {
    // With the collapse toggle gone on mobile, the scrim is the only
    // non-navigational way out — so it has to be reachable and announced,
    // not just tappable.
    renderSidebar();

    const scrim = screen.getByTestId("sidebar-scrim");
    expect(scrim.tagName).toBe("BUTTON");
    expect(scrim).toHaveAttribute("aria-label", "Close sidebar");
    expect(scrim).toHaveAttribute("tabindex", "0");
    expect(scrim).toHaveAttribute("aria-hidden", "false");
  });

  it("stacks the scrim above chat chrome but below the drawer", () => {
    // Chat chrome (ChatPage's jump-to-top pill) also sits at z-40 and renders
    // after the sidebar, so a same-z scrim would lose the tie inside the strip.
    renderSidebar();

    expect(screen.getByTestId("sidebar-scrim")).toHaveClass("z-[45]");
    expect(screen.getByRole("complementary", { name: "Conversations" })).toHaveClass("z-50");
  });

  it("stops the drawer short of the right edge so the chat stays reachable", () => {
    renderSidebar();

    expect(screen.getByRole("complementary", { name: "Conversations" })).toHaveClass(
      "max-md:right-14",
    );
  });

  it("drops the peek strip and the scrim on the settings page, where Back is the only exit", () => {
    renderSidebar({ route: "/settings" });

    expect(screen.queryByTestId("sidebar-scrim")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Conversations" })).not.toHaveClass(
      "max-md:right-14",
    );
  });

  it("keeps the labeled Settings link below the session list and outside its scroller", () => {
    renderSidebar();
    const footer = screen.getByTestId("sidebar-settings-footer");
    const settings = within(footer).getByRole("link", { name: "Settings" });
    expect(settings).toHaveAttribute("href", "/settings");
    expect(settings).toHaveClass("density-row", "w-full");
    expect(screen.getByRole("navigation")).not.toContainElement(footer);
    expect(screen.getByTestId("sidebar-primary-nav")).not.toContainElement(settings);
  });
});
