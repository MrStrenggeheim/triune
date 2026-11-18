import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setEmbedRoot, setEmbedScopeRoot } from "./host";
import {
  applyListDensity,
  DEFAULT_LIST_DENSITY,
  isListDensity,
  LIST_DENSITY_STORAGE_KEY,
  readListDensity,
  useListDensity,
  writeListDensity,
} from "./listDensityPreferences";
import { applyImportedSettings, collectSettings } from "./settingsPortability";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-list-density");
  setEmbedScopeRoot(null);
  setEmbedRoot(null);
});

describe("list density", () => {
  it.each([null, "unknown", '"compact"'])("defaults safely for %s", (stored) => {
    if (stored !== null) localStorage.setItem(LIST_DENSITY_STORAGE_KEY, stored);
    expect(readListDensity()).toBe(DEFAULT_LIST_DENSITY);
    expect(isListDensity(stored)).toBe(false);
  });

  it("restores saved density and follows same-window, cross-window and cleared preferences", () => {
    localStorage.setItem(LIST_DENSITY_STORAGE_KEY, "compact");
    const { result } = renderHook(useListDensity);
    expect(result.current).toBe("compact");
    expect(document.documentElement).toHaveAttribute("data-list-density", "compact");
    act(() => writeListDensity("comfortable"));
    expect(result.current).toBe("comfortable");
    act(() => {
      localStorage.setItem(LIST_DENSITY_STORAGE_KEY, "compact");
      window.dispatchEvent(new StorageEvent("storage", { key: LIST_DENSITY_STORAGE_KEY }));
    });
    expect(result.current).toBe("compact");
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current).toBe("compact");
    expect(document.documentElement).toHaveAttribute("data-list-density", "compact");
  });

  it("updates both embedded roots without touching the host document", () => {
    const scope = document.createElement("div");
    const inner = document.createElement("div");
    setEmbedScopeRoot(scope);
    setEmbedRoot(inner);
    applyListDensity("compact");
    expect(scope).toHaveAttribute("data-list-density", "compact");
    expect(inner).toHaveAttribute("data-list-density", "compact");
    expect(document.documentElement).not.toHaveAttribute("data-list-density");
  });

  it("uses the default when storage cannot be read and applies changes when writes fail", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(readListDensity()).toBe(DEFAULT_LIST_DENSITY);
    expect(() => writeListDensity("compact")).not.toThrow();
    expect(document.documentElement).toHaveAttribute("data-list-density", "compact");
  });

  it("round-trips settings and updates mounted consumers during import", () => {
    const { result } = renderHook(useListDensity);
    act(() => writeListDensity("comfortable"));
    const exported = collectSettings()!;
    act(() => applyImportedSettings({ version: 1, settings: {} }));
    expect(result.current).toBe("compact");
    act(() => applyImportedSettings(exported));
    expect(result.current).toBe("comfortable");
    expect(document.documentElement).toHaveAttribute("data-list-density", "comfortable");
  });
});
