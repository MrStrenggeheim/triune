// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, expect, it, vi } from "vitest";
import { getOmnigentTransformShareLink } from "./host";
import { copySessionLink, getShareableLink } from "./sessionShareLink";

vi.mock("./host", () => ({ getOmnigentTransformShareLink: vi.fn() }));
afterEach(() => {
  delete window.__OMNIGENT_BASE_PATH__;
  vi.resetAllMocks();
});
it("shares exact standalone base-path bytes, including already rebased paths", async () => {
  window.__OMNIGENT_BASE_PATH__ = "/proxy/6767/";
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  const expected = `${window.location.origin}/proxy/6767/c/other`;
  expect(getShareableLink("other", (path) => path)).toBe(expected);
  await copySessionLink("other", (path) => `/proxy/6767${path}`);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
});
it("uses the embedded host transform after basename rebasing without a standalone prefix", async () => {
  window.__OMNIGENT_BASE_PATH__ = "/unused";
  vi.mocked(getOmnigentTransformShareLink).mockReturnValue((path) => `https://host.test/#${path}`);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  await copySessionLink("other", (path) => `/embedded${path}`);
  expect(writeText).toHaveBeenCalledExactlyOnceWith("https://host.test/#/embedded/c/other");
});
