// Modified for Triune.
import { type ReactNode, useEffect } from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { setThemeSource } from "@/lib/nativeBridge";

/** Mirrors the selected appearance onto native and browser chrome. */
function ThemeChromeSync() {
  const { theme } = useTheme();
  useEffect(() => {
    if (theme === "light" || theme === "dark" || theme === "system") {
      setThemeSource(theme);
    }
  }, [theme]);
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
    if (!meta) return;
    const root = document.documentElement;
    const original = meta.getAttribute("content");
    let applied: string | undefined;
    let canvas: CanvasRenderingContext2D | null | undefined;
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;transition:none;background:var(--workspace-appbar)";
    root.append(probe);
    const sync = () => {
      if (!getComputedStyle(root).getPropertyValue("--workspace-appbar").trim()) return;
      if (canvas === undefined) {
        const element = document.createElement("canvas");
        element.width = 1;
        element.height = 1;
        canvas = element.getContext("2d", { willReadFrequently: true });
      }
      if (!canvas) return;
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = getComputedStyle(probe).backgroundColor;
      canvas.fillRect(0, 0, 1, 1);
      const channels = [...canvas.getImageData(0, 0, 1, 1).data];
      if (channels[3] !== 255) return;
      applied =
        "#" +
        channels
          .slice(0, 3)
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
      meta.setAttribute("content", applied);
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    window.addEventListener("pageshow", sync);
    sync();
    return () => {
      observer.disconnect();
      window.removeEventListener("pageshow", sync);
      probe.remove();
      if (applied !== undefined && meta.getAttribute("content") === applied) {
        if (original === null) meta.removeAttribute("content");
        else meta.setAttribute("content", original);
      }
    };
  }, []);
  return null;
}

/**
 * App-wide theme provider configured for Tailwind's `.dark` class variant.
 *
 * Defaults to system preference and stores explicit user selection under
 * an web-specific key so it does not collide with unrelated local apps
 * on the same host.
 *
 * @param children React tree that should inherit theme context.
 * @returns React provider wrapping the app.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="web-theme"
    >
      <ThemeChromeSync />
      {children}
    </NextThemesProvider>
  );
}
