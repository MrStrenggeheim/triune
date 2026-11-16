// Modified for Triune.
import type { ReactNode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "./ThemeProvider";

const themeState = vi.hoisted(() => ({
  setThemeSource: vi.fn(),
  theme: "system" as string | undefined,
}));

vi.mock("@/lib/nativeBridge", () => ({
  setThemeSource: themeState.setThemeSource,
}));

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({ theme: themeState.theme }),
}));

beforeEach(() => {
  themeState.setThemeSource.mockClear();
  themeState.theme = "system";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  document.documentElement.style.removeProperty("--workspace-appbar");
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
});

function browserChrome() {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "#0d1218";
  document.head.append(meta);
  document.documentElement.style.setProperty("--workspace-appbar", "#d5cedf");
  let color = [213, 206, 223, 255];
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    getImageData: () => ({ data: color }),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  return {
    meta,
    color: (value: number[]) => {
      color = value;
    },
  };
}

describe("ThemeProvider native theme sync", () => {
  it("tells the native shell to follow the system theme by default", () => {
    render(<ThemeProvider>content</ThemeProvider>);
    expect(themeState.setThemeSource).toHaveBeenCalledWith("system");
  });

  it("updates the native shell when the user selects an explicit theme", () => {
    const { rerender } = render(<ThemeProvider>content</ThemeProvider>);
    themeState.setThemeSource.mockClear();

    themeState.theme = "light";
    rerender(<ThemeProvider>content</ThemeProvider>);

    expect(themeState.setThemeSource).toHaveBeenCalledWith("light");
  });
});

describe("ThemeProvider browser chrome sync", () => {
  it("updates the existing canonical meta and restores its original value on unmount", () => {
    const { meta } = browserChrome();
    const media = document.createElement("meta");
    media.name = "theme-color";
    media.setAttribute("media", "(prefers-color-scheme: dark)");
    media.content = "#112233";
    document.head.prepend(media);
    const view = render(<ThemeProvider>content</ThemeProvider>);
    expect(meta.content).toBe("#d5cedf");
    expect(media.content).toBe("#112233");
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(2);
    view.unmount();
    expect(meta.content).toBe("#0d1218");
    expect(media.content).toBe("#112233");
  });

  it("follows mode, selected palette and custom color changes through one root observer", async () => {
    const { meta, color } = browserChrome();
    render(<ThemeProvider>content</ThemeProvider>);
    color([46, 39, 58, 255]);
    document.documentElement.classList.add("dark");
    await waitFor(() => expect(meta.content).toBe("#2e273a"));
    color([21, 58, 62, 255]);
    document.documentElement.dataset.theme = "custom";
    await waitFor(() => expect(meta.content).toBe("#153a3e"));
    color([28, 63, 69, 255]);
    document.documentElement.style.setProperty("--workspace-appbar", "#1c3f45");
    await waitFor(() => expect(meta.content).toBe("#1c3f45"));
    expect(themeState.setThemeSource).toHaveBeenCalledTimes(1);
  });

  it("leaves a newer metadata owner's value intact during cleanup", () => {
    const { meta } = browserChrome();
    const view = render(<ThemeProvider>content</ThemeProvider>);
    meta.content = "#123456";
    view.unmount();
    expect(meta.content).toBe("#123456");
  });

  it("retains the original fallback when the appbar token or opaque paint is unavailable", async () => {
    const { meta, color } = browserChrome();
    document.documentElement.style.removeProperty("--workspace-appbar");
    render(<ThemeProvider>content</ThemeProvider>);
    expect(meta.content).toBe("#0d1218");
    color([0, 0, 0, 0]);
    document.documentElement.style.setProperty("--workspace-appbar", "transparent");
    await waitFor(() => expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled());
    expect(meta.content).toBe("#0d1218");
  });
});
