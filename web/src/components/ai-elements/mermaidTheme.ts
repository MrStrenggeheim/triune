// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useMemo, useSyncExternalStore } from "react";
import type { DiagramPlugin, MermaidConfig } from "@streamdown/mermaid";
import { getEmbedRoot, getStyleRoot, getThemeRoots } from "@/lib/host";
import { DEFAULT_PALETTE, PALETTES } from "@/lib/themePalette";
import {
  mermaidBoundary,
  mermaidTextOn,
  mixMermaidColor,
  presentMermaidSvg,
  serializeMermaidSvg,
  type MermaidSurfaces,
} from "./mermaidPresentation";
import type { ResolvedThemeMode } from "@/components/theme/themeMode";

export const MERMAID_ENGINE_VERSION = "11.16.1";
const SYSTEM_FONT =
  'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

export interface MermaidAppearance {
  key: string;
  config: MermaidConfig;
  surfaces: MermaidSurfaces;
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
    const foreground = mermaidTextOn(
      content,
      color("--foreground", fallback.foreground, content),
      content,
    );
    const muted = color("--muted-foreground", fallback.mutedForeground, content);
    const border = color("--border", fallback.border, content);
    const strong = color("--border-strong", fallback.borderStrong, content);
    const primary = color("--primary", fallback.primary, content);
    const washAccent = mode === "dark" ? color("--link", fallback.link, content) : primary;
    const groups = [0.08, 0.16, 0.24].map((weight) => mixMermaidColor(washAccent, content, weight));
    const surfaces = [content, ...groups];
    const outline = mermaidBoundary(strong, surfaces, foreground);
    const edge = mermaidBoundary(muted, surfaces, foreground);
    const accentStroke = mermaidBoundary(primary, surfaces, foreground);
    // Categorical families use selected-accent/chart tokens; ordinary nodes stay neutral.
    const hues = [
      primary,
      ...[1, 2, 3, 4, 5].map((index) => color(`--chart-${index}`, primary, content)),
    ];
    const fills = hues.map((hue) => mixMermaidColor(hue, content, 0.22));
    const strokes = hues.map((hue) => mermaidBoundary(hue, surfaces, foreground));
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
        strokeWidth: 1,
        background: content,
        primaryColor: content,
        primaryTextColor: foreground,
        primaryBorderColor: outline,
        secondaryColor: groups[0],
        secondaryTextColor: mermaidTextOn(groups[0], foreground, content),
        secondaryBorderColor: outline,
        tertiaryColor: groups[1],
        tertiaryTextColor: mermaidTextOn(groups[1], foreground, content),
        tertiaryBorderColor: outline,
        mainBkg: content,
        lineColor: edge,
        textColor: foreground,
        nodeTextColor: foreground,
        nodeBorder: outline,
        defaultLinkColor: edge,
        edgeLabelBackground: content,
        clusterBkg: groups[0],
        clusterBorder: outline,
        titleColor: foreground,
        actorBkg: content,
        actorBorder: outline,
        actorTextColor: foreground,
        actorLineColor: edge,
        signalColor: edge,
        signalTextColor: foreground,
        labelBoxBkgColor: content,
        labelBoxBorderColor: outline,
        labelTextColor: foreground,
        loopTextColor: foreground,
        noteBkgColor: groups[0],
        noteTextColor: mermaidTextOn(groups[0], foreground, content),
        noteBorderColor: outline,
        activationBkgColor: groups[2],
        activationBorderColor: accentStroke,
        sequenceNumberColor: mermaidTextOn(edge, foreground, content),
        nodeBkg: content,
        arrowheadColor: edge,
        rectBkgColor: groups[0],
        stateBkg: content,
        stateLabelColor: foreground,
        transitionColor: edge,
        transitionLabelColor: foreground,
        compositeBackground: groups[0],
        compositeTitleBackground: groups[1],
        altBackground: groups[1],
        compositeBorder: outline,
        innerEndBackground: outline,
        specialStateColor: foreground,
        classText: foreground,
        relationColor: edge,
        relationLabelColor: foreground,
        relationLabelBackground: content,
        attributeBackgroundColorOdd: content,
        attributeBackgroundColorEven: groups[0],
        requirementBackground: content,
        requirementBorderColor: outline,
        requirementTextColor: foreground,
        taskBkgColor: fills[0],
        taskBorderColor: outline,
        activeTaskBkgColor: fills[1],
        activeTaskBorderColor: strokes[1],
        doneTaskBkgColor: groups[0],
        doneTaskBorderColor: outline,
        critBkgColor: fills[4],
        critBorderColor: strokes[4],
        taskTextColor: mermaidTextOn(fills[0], foreground, content),
        taskTextOutsideColor: foreground,
        taskTextLightColor: mermaidTextOn(fills[0], foreground, content),
        taskTextDarkColor: mermaidTextOn(fills[0], foreground, content),
        sectionBkgColor: groups[0],
        sectionBkgColor2: content,
        altSectionBkgColor: content,
        gridColor: border,
        todayLineColor: accentStroke,
        sectionTitleColor: foreground,
        labelBackgroundColor: content,
        scaleLabelColor: foreground,
        pieTitleTextColor: foreground,
        pieSectionTextColor: foreground,
        pieLegendTextColor: foreground,
        pieStrokeColor: content,
        pieStrokeWidth: "2px",
        pieOuterStrokeWidth: "0px",
        pieOpacity: 1,
        pieTitleTextSize: `${fontSize}px`,
        pieSectionTextSize: `${fontSize}px`,
        pieLegendTextSize: `${fontSize}px`,
        quadrant1Fill: groups[0],
        quadrant2Fill: content,
        quadrant3Fill: groups[1],
        quadrant4Fill: groups[0],
        quadrant1TextFill: mermaidTextOn(groups[0], foreground, content),
        quadrant2TextFill: foreground,
        quadrant3TextFill: mermaidTextOn(groups[1], foreground, content),
        quadrant4TextFill: mermaidTextOn(groups[0], foreground, content),
        quadrantPointFill: accentStroke,
        quadrantPointTextFill: foreground,
        quadrantXAxisTextFill: foreground,
        quadrantYAxisTextFill: foreground,
        quadrantTitleFill: foreground,
        quadrantInternalBorderStrokeFill: edge,
        quadrantExternalBorderStrokeFill: edge,
        archEdgeColor: edge,
        archEdgeArrowColor: edge,
        archGroupBorderColor: outline,
        branchLabelColor: foreground,
        commitLabelColor: foreground,
        commitLabelBackground: content,
        tagLabelColor: mermaidTextOn(groups[0], foreground, content),
        tagLabelBackground: groups[0],
        tagLabelBorder: outline,
        personBkg: groups[0],
        personBorder: outline,
        xyChart: {
          backgroundColor: content,
          titleColor: foreground,
          xAxisLabelColor: foreground,
          xAxisTitleColor: foreground,
          xAxisTickColor: edge,
          xAxisLineColor: edge,
          yAxisLabelColor: foreground,
          yAxisTitleColor: foreground,
          yAxisTickColor: edge,
          yAxisLineColor: edge,
          plotColorPalette: strokes.join(","),
        },
        radar: {
          axisColor: edge,
          axisStrokeWidth: 1,
          graticuleColor: border,
          graticuleStrokeWidth: 1,
          legendTextColor: foreground,
          curveOpacity: 0.15,
          curveStrokeWidth: 2,
          curveTension: 0.15,
        },
      },
      // Set typography before measurement; retain native semantic shapes and arrow conventions.
      themeCSS: `text,.nodeLabel,.edgeLabel,.edgeTerminals {font-family:${fontFamily} !important;font-size:${fontSize}px !important;}
.edge-thickness-normal {stroke-width:1.25px;}
.cluster > rect {stroke-width:1px;}
.mindmap-node.section-root > .label-container {fill:${content};stroke:${outline};}
.packetBlock {fill:${groups[0]};stroke:${outline};}
.packetLabel,.packetByte.start,.packetByte.end,.packetTitle {fill:${mermaidTextOn(groups[0], foreground, content)};}`,
      flowchart: {
        htmlLabels: true,
        curve: "linear",
        nodeSpacing: 24,
        rankSpacing: 56,
        subGraphTitleMargin: { top: 4, bottom: 8 },
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
    for (let index = 0; index < 12; index++) {
      const fill = fills[index % fills.length],
        stroke = strokes[index % strokes.length];
      Object.assign(config.themeVariables!, {
        [`cScale${index}`]: fill,
        [`cScaleLabel${index}`]: mermaidTextOn(fill, foreground, content),
        [`cScaleInv${index}`]: outline,
        [`pie${index + 1}`]: fill,
        ...(index < 8 ? { [`venn${index + 1}`]: stroke } : {}),
        ...(index < 8
          ? {
              [`fillType${index}`]: fill,
              [`git${index}`]: stroke,
              [`gitInv${index}`]: content,
              [`gitBranchLabel${index}`]: mermaidTextOn(stroke, foreground, content),
            }
          : {}),
      });
    }
    config.gantt = { fontSize, sectionFontSize: fontSize };
    config.c4 = {};
    for (const name of [
      "person",
      "external_person",
      "system",
      "external_system",
      "system_db",
      "external_system_db",
      "system_queue",
      "external_system_queue",
      "container",
      "external_container",
      "container_db",
      "external_container_db",
      "container_queue",
      "external_container_queue",
      "component",
      "external_component",
      "component_db",
      "external_component_db",
      "component_queue",
      "external_component_queue",
      "boundary",
      "message",
    ]) {
      Object.assign(config.c4, {
        [`${name}FontFamily`]: fontFamily,
        [`${name}FontSize`]: fontSize,
        [`${name}_bg_color`]: name.startsWith("external_") ? groups[0] : content,
        [`${name}_border_color`]: outline,
      });
    }
    return {
      key: JSON.stringify([MERMAID_ENGINE_VERSION, mode, config]),
      config,
      surfaces: { canvas: content, foreground, groups },
    };
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
        attributeFilter: ["style", "class", "data-theme", "data-list-density"],
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
          const { mermaid } = await import("@streamdown/mermaid");
          const result = await mermaid.getMermaid(config).render(id, source);
          // Strict mode sanitizes first; presentation adds only measured SVG primitives and resolved colors.
          const svg = new DOMParser().parseFromString(result.svg, "text/html").querySelector("svg");
          if (!svg) throw new Error("Mermaid returned no SVG");
          const stage = document.createElement("div");
          stage.style.cssText =
            "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;width:max-content";
          (getEmbedRoot() ?? getStyleRoot() ?? document.body).appendChild(stage);
          try {
            stage.appendChild(svg);
            presentMermaidSvg(svg, appearance.surfaces);
            return { svg: serializeMermaidSvg(svg) };
          } finally {
            stage.remove();
          }
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
