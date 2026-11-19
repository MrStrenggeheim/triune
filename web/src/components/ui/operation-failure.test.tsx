// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { OperationFailure } from "./operation-failure";

it("announces an operation error without requiring a recovery action", () => {
  render(<OperationFailure>Could not stop the shell.</OperationFailure>);

  expect(screen.getByRole("alert")).toHaveTextContent("Could not stop the shell.");
  expect(screen.queryByRole("button")).toBeNull();
});

it("offers a neutral retry and prevents another request while retrying", () => {
  const retry = vi.fn();
  const { rerender } = render(
    <OperationFailure onRetry={retry}>Couldn&apos;t load sessions.</OperationFailure>,
  );

  const button = screen.getByRole("button", { name: "Retry" });
  expect(button).toHaveAttribute("data-variant", "ghost");
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledOnce();

  rerender(
    <OperationFailure onRetry={retry} retrying>
      Couldn&apos;t load sessions.
    </OperationFailure>,
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
});
