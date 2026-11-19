import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServerUpdateDialog } from "./ServerUpdateDialog";

describe("ServerUpdateDialog", () => {
  const props = {
    installed: "v1.0",
    available: "v1.1",
    notes: "Fix reconnecting after a restart.",
    busy: false,
    error: null,
  };

  it("shows the release being confirmed and lets Later dismiss without installation", () => {
    const onLater = vi.fn();
    const onInstall = vi.fn();
    render(<ServerUpdateDialog {...props} onInstall={onInstall} onLater={onLater} />);
    expect(screen.getByRole("dialog", { name: "Server update available" })).toBeVisible();
    for (const value of [props.installed, props.available, props.notes]) {
      expect(screen.getByText(value)).toBeVisible();
    }
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onLater).toHaveBeenCalledOnce();
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("locks both actions while submitting and renders absent notes as text", () => {
    render(
      <ServerUpdateDialog {...props} busy notes={null} onInstall={vi.fn()} onLater={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Later" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update & restart" })).toBeDisabled();
    expect(screen.getByText("No release notes were published.")).toBeVisible();
  });
});
