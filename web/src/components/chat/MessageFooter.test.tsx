// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/notifications";
import { MessageFooter } from "./MessageFooter";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  ["Copy", "Could not copy message"],
  ["Copy link", "Could not copy message link"],
])("shows a visible failure when %s is rejected", async (action, message) => {
  const errorToast = vi.spyOn(toast, "error").mockReturnValue("copy-error");
  vi.mocked(copyText).mockRejectedValueOnce(new Error("Clipboard unavailable"));
  render(<MessageFooter text="Full report" messageId="item" conversationId="owning-chat" />);

  fireEvent.click(screen.getByRole("button", { name: action }));

  await waitFor(() => expect(errorToast).toHaveBeenCalledWith(message));
  expect(screen.getByRole("button", { name: action })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Copied!" })).not.toBeInTheDocument();
});
