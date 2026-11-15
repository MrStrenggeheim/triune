// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useMemo, useSyncExternalStore } from "react";
import { mermaid, type DiagramPlugin, type MermaidConfig } from "@streamdown/mermaid";
import { getEmbedRoot, getStyleRoot, getThemeRoots } from "@/lib/host";
import { DEFAULT_PALETTE, PALETTES } from "@/lib/themePalette";
import type { ResolvedThemeMode } from "@/components/theme/themeMode";

export const MERMAID_ENGINE_VERSION = "11.16.1";
const SYSTEM_FONT =
  'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

export interface MermaidAppearance {
  key: string;
  config: MermaidConfig;
}

/** Resolve mixes, OKLCH and transparency into the concrete sRGB colors Mermaid expects. */
export function resolveMermaidAppearance(mode: ResolvedThemeMode): MermaidAppearance {
  const fallback = PALETTES.find((palette) => palette.id === DEFAULT_PALETTE)!.tokens[mode];
  const root = getEmbedRoot() ?? getStyleRoot();
  const style = root ? getComputedStyle(root) : null;
  const probe = root ? document.createElement("span") : null;
  if (probe && root) {
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
    root.appendChild(probe);
  }
  let canvas: CanvasRenderingContext2D | null = null;
  function color(token: string, missing: string, background = "#ffffff"): string {
    let value = style?.getPropertyValue(token).trim() || missing;
    if (probe) {
      probe.style.color = value;
      value = getComputedStyle(probe).color || value;
    }
    if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
    if (rgb) {
      const channels = rgb[1].split(/[\s,/]+/).map(Number);
      const alpha = channels[3] ?? 1;
      const base = background
        .slice(1)
        .match(/../g)!
        .map((channel) => parseInt(channel, 16));
      return (
        "#" +
        channels
          .slice(0, 3)
          .map((channel, index) =>
            Math.round(channel * alpha + base[index] * (1 - alpha))
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")
      );
    }
    if (!canvas) {
      const element = document.createElement("canvas");
      element.width = element.height = 1;
      canvas = element.getContext("2d", { willReadFrequently: true });
    }
    if (!canvas) throw new Error(`Cannot resolve Mermaid theme color ${token}`);
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = background;
    canvas.fillRect(0, 0, 1, 1);
    canvas.fillStyle = value;
    canvas.fillRect(0, 0, 1, 1);
    return (
      "#" +
      [...canvas.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")
    );
  }
  try {
    const content = color("--workspace-content", mode === "dark" ? "#18181b" : "#ffffff");
    const foreground = color("--foreground", fallback.foreground, content);
    const muted = color("--muted-foreground", fallback.mutedForeground, content);
    const border = color("--border", fallback.border, content);
    const strong = color("--border-strong", fallback.borderStrong, content);
    const primary = color("--primary", fallback.primary, content);
    const chrome = color("--workspace-chrome", content, content);
    const selected = color("--workspace-selected", chrome, content);
    if (probe) {
      probe.style.fontFamily =
        style?.getPropertyValue("--ui-font-family").trim() ||
        style?.getPropertyValue("--font-sans").trim() ||
        SYSTEM_FONT;
      probe.style.fontSize = style?.getPropertyValue("--text-ui").trim() || "14px";
    }
    const fontStyle = probe ? getComputedStyle(probe) : null;
    const fontFamily = fontStyle?.fontFamily || SYSTEM_FONT;
    // Diagram labels retain the reviewed 14px minimum while honoring larger UI sizes.
    const fontSize = Math.max(14, parseFloat(fontStyle?.fontSize || "14") || 14);
    const radius = (name: string, missing: number) =>
      parseFloat(style?.getPropertyValue(name) || "") || missing;
    const small = radius("--radius-sm", 4),
      medium = radius("--radius-md", 6),
      large = radius("--radius-lg", 8);
    const config: MermaidConfig = {
      startOnLoad: false,
      theme: "base",
      look: "classic",
      layout: "dagre",
      securityLevel: "strict",
      fontFamily,
      fontSize,
      suppressErrorRendering: true,
      themeVariables: {
        darkMode: mode === "dark",
        fontFamily,
        fontSize: `${fontSize}px`,
        radius: medium,
        strokeWidth: 1,
        background: content,
        primaryColor: content,
        primaryTextColor: foreground,
        primaryBorderColor: strong,
        secondaryColor: chrome,
        secondaryTextColor: foreground,
        secondaryBorderColor: border,
        tertiaryColor: chrome,
        tertiaryTextColor: foreground,
        tertiaryBorderColor: border,
        mainBkg: content,
        lineColor: muted,
        textColor: foreground,
        nodeTextColor: foreground,
        nodeBorder: strong,
        defaultLinkColor: muted,
        edgeLabelBackground: content,
        clusterBkg: chrome,
        clusterBorder: border,
        titleColor: foreground,
        actorBkg: chrome,
        actorBorder: strong,
        actorTextColor: foreground,
        actorLineColor: strong,
        signalColor: muted,
        signalTextColor: foreground,
        labelBoxBkgColor: content,
        labelBoxBorderColor: border,
        labelTextColor: foreground,
        loopTextColor: muted,
        noteBkgColor: chrome,
        noteTextColor: foreground,
        noteBorderColor: border,
        activationBkgColor: selected,
        activationBorderColor: primary,
        sequenceNumberColor: foreground,
      },
      // Classic 11.16.1 does not map the shared radius to these shapes.
      // Native circles, diamonds and other semantic node shapes stay untouched.
      themeCSS: `.cluster > rect { rx: ${large}px; ry: ${large}px; }\nrect.actor { rx: ${medium}px; ry: ${medium}px; }\nrect.note { rx: ${small}px; ry: ${small}px; }`,
      flowchart: {
        htmlLabels: true,
        curve: "linear",
        nodeSpacing: 24,
        rankSpacing: 28,
        padding: 12,
        useMaxWidth: false,
      },
      sequence: {
        mirrorActors: false,
        actorFontSize: fontSize,
        messageFontSize: fontSize,
        noteFontSize: fontSize,
        actorMargin: 42,
        width: 124,
        height: 48,
        messageMargin: 28,
        diagramMarginX: 16,
        diagramMarginY: 12,
        useMaxWidth: false,
      },
    };
    return { key: JSON.stringify([MERMAID_ENGINE_VERSION, mode, config]), config };
  } finally {
    probe?.remove();
  }
}

let revision = 0;
const listeners = new Set<() => void>();
let stopObserving: (() => void) | undefined;
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopObserving) {
    const changed = () => {
      revision++;
      for (const notify of listeners) notify();
    };
    const observer = new MutationObserver(changed);
    for (const root of new Set(getThemeRoots()))
      observer.observe(root, {
        attributes: true,
        attributeFilter: ["style", "class", "data-theme"],
      });
    const media = window.matchMedia("(width < 48rem)");
    media.addEventListener("change", changed);
    document.fonts?.addEventListener("loadingdone", changed);
    stopObserving = () => {
      observer.disconnect();
      media.removeEventListener("change", changed);
      document.fonts?.removeEventListener("loadingdone", changed);
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopObserving?.();
      stopObserving = undefined;
    }
  };
}

/** Observes the existing app/embed theme roots; unrelated transcript state stays mounted. */
export function useMermaidAppearance(mode: ResolvedThemeMode): MermaidAppearance {
  const current = useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0,
  );
  return useMemo(() => resolveMermaidAppearance(mode), [mode, current]);
}

// All Mermaid callers, including recovery and download, share the same engine queue.
let rendering: Promise<unknown> = Promise.resolve();
const renders = new Map<string, Promise<{ svg: string }>>();
export const triuneMermaid: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid(initial = {}) {
    let options = initial;
    return {
      initialize(config) {
        options = { ...options, ...config };
      },
      render(id, source) {
        const mode =
          options.themeVariables?.darkMode || options.theme === "dark" ? "dark" : "light";
        const appearance = resolveMermaidAppearance(mode);
        const config = { ...options, ...appearance.config };
        // Retain consumer SVG identity: sharing markup across IDs creates duplicate DOM references.
        const key = JSON.stringify([MERMAID_ENGINE_VERSION, id, source, appearance.key, config]);
        const cached = renders.get(key);
        if (cached) return cached;
        const result = rendering.then(async () => {
          if (document.fonts) {
            await document.fonts.load(`${config.fontSize}px ${config.fontFamily}`);
            await document.fonts.ready;
          }
          const result = await mermaid.getMermaid(config).render(id, source);
          // XML serialization preserves XHTML void tags for SVG downloads without restyling.
          const svg = new DOMParser().parseFromString(result.svg, "text/html").querySelector("svg");
          if (!svg) throw new Error("Mermaid returned no SVG");
          // HTML parsers can leave xmlns as an unnamespaced attribute; XMLSerializer
          // already emits the element's namespace and would otherwise duplicate it.
          for (const element of [svg, ...svg.querySelectorAll("[xmlns]")]) {
            if (element.getAttributeNode("xmlns")?.namespaceURI === null)
              element.removeAttribute("xmlns");
          }
          return { svg: new XMLSerializer().serializeToString(svg) };
        });
        rendering = result.catch(() => undefined);
        renders.set(key, result);
        if (renders.size > 32) renders.delete(renders.keys().next().value!);
        void result.catch(() => {
          renders.delete(key);
        });
        return result;
      },
    };
  },
};
