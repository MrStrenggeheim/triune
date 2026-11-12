// Modified for Triune.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import logoAsset from "@/assets/omnigent-logo.svg";
import { OmnigentLogo } from "./OmnigentLogo";

afterEach(cleanup);

it("renders the approved local vector with an accessible name and caller sizing", () => {
  render(<OmnigentLogo className="h-6 w-6" />);
  const logo = screen.getByRole("img", { name: "Triune" });
  expect(logo).toHaveAttribute("src", logoAsset);
  expect(logo).toHaveClass("h-6", "w-6");
  expect(logo).not.toHaveClass("h-8", "w-7");
});
