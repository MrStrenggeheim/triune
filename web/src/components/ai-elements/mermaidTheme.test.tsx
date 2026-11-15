// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEmbedRoot, setEmbedScopeRoot } from "@/lib/host";
import { resolveMermaidAppearance, triuneMermaid, useMermaidAppearance } from "./mermaidTheme";

const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("@streamdown/mermaid", () => ({
  mermaid: {
    getMermaid: (config: unknown) => {
      engine.initialize(config);
      return { render: engine.render };
    },
  },
}));

beforeEach(() => {
  engine.initialize.mockReset();
  engine.render.mockReset();
  engine.render.mockImplementation(async (id: string) => ({
    svg: `<svg id="${id}"><text>Ready</text></svg>`,
  }));
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
  setEmbedRoot(null);
  setEmbedScopeRoot(null);
});

describe("resolved Mermaid theme", () => {
  it("uses app tokens, measured UI typography and only the three renderer radius gaps", () => {
    const style = document.documentElement.style;
    style.setProperty("--workspace-content", "#fefefe");
    style.setProperty("--foreground", "#123456");
    style.setProperty("--primary", "#1c7455");
    style.setProperty("--workspace-chrome", "#eef7f3");
    style.setProperty("--ui-font-family", "Georgia");
    style.setProperty("--text-ui", "17px");
    const { config } = resolveMermaidAppearance("light");
    expect(config).toMatchObject({
      theme: "base",
      fontFamily: "Georgia",
      fontSize: 17,
      securityLevel: "strict",
      look: "classic",
      layout: "dagre",
    });
    expect(config.themeVariables).toMatchObject({
      primaryColor: "#fefefe",
      primaryTextColor: "#123456",
      activationBorderColor: "#1c7455",
      actorBkg: "#eef7f3",
      fontSize: "17px",
      radius: 6,
    });
    expect(config.themeCSS).toContain(".cluster > rect { rx: 8px; ry: 8px; }");
    expect(config.themeCSS).toContain("rect.actor { rx: 6px; ry: 6px; }");
    expect(config.themeCSS).toContain("rect.note { rx: 4px; ry: 4px; }");
    expect(config.themeCSS).not.toMatch(/\.node|circle|path|font|fill|stroke/);
    expect(config.flowchart?.useMaxWidth).toBe(false);
  });

  it("composites translucent boundaries onto the actual content surface", () => {
    document.documentElement.style.setProperty("--workspace-content", "#18181b");
    document.documentElement.style.setProperty("--border", "rgba(255, 0, 0, 0.5)");
    expect(resolveMermaidAppearance("dark").config.themeVariables?.clusterBorder).toBe("#8c0c0e");
  });

  it("resolves the embedded dark root rather than unrelated document tokens", () => {
    const scope = document.createElement("div");
    const inner = document.createElement("div");
    document.body.append(scope);
    scope.append(inner);
    scope.style.setProperty("--foreground", "#aaaaaa");
    inner.style.setProperty("--foreground", "#abcdef");
    setEmbedScopeRoot(scope);
    setEmbedRoot(inner);
    try {
      expect(resolveMermaidAppearance("dark").config.themeVariables?.primaryTextColor).toBe(
        "#abcdef",
      );
    } finally {
      scope.remove();
    }
  });

  it("changes identity for accent, font and mode changes", () => {
    const first = resolveMermaidAppearance("light").key;
    document.documentElement.style.setProperty("--primary", "#ff0000");
    const accent = resolveMermaidAppearance("light").key;
    document.documentElement.style.setProperty("--ui-font-family", "Georgia");
    const font = resolveMermaidAppearance("light").key;
    expect(new Set([first, accent, font, resolveMermaidAppearance("dark").key]).size).toBe(4);
  });

  it("observes Appearance changes without remounting unrelated content", async () => {
    function Subject() {
      const appearance = useMermaidAppearance("light");
      return (
        <output data-testid="appearance">
          {appearance.config.themeVariables?.activationBorderColor}
        </output>
      );
    }
    render(<Subject />);
    document.documentElement.style.setProperty("--primary", "#1c7455");
    await waitFor(() => expect(screen.getByTestId("appearance")).toHaveTextContent("#1c7455"));
  });
});

describe("shared Mermaid engine queue", () => {
  it("waits for selected fonts before initializing or measuring the diagram", async () => {
    const previous = Object.getOwnPropertyDescriptor(document, "fonts");
    let loaded!: () => void;
    const ready = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const load = vi.fn(() => ready);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load, ready } });
    try {
      const result = triuneMermaid.getMermaid().render("font-ready", "flowchart LR\nA-->B");
      await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      expect(engine.initialize).not.toHaveBeenCalled();
      loaded();
      await result;
      expect(engine.render).toHaveBeenCalledTimes(1);
    } finally {
      if (previous) Object.defineProperty(document, "fonts", previous);
      else delete (document as { fonts?: unknown }).fonts;
    }
  });

  it("initializes inside the render queue, keeping concurrent appearances coherent", async () => {
    let release!: (result: { svg: string }) => void;
    engine.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const light = triuneMermaid.getMermaid({ themeVariables: { darkMode: false } });
    const dark = triuneMermaid.getMermaid({ themeVariables: { darkMode: true } });
    const first = light.render("queue-light", "flowchart LR\nA-->B");
    const second = dark.render("queue-dark", "sequenceDiagram\nA->>B: hello");
    expect(engine.initialize).not.toHaveBeenCalled();
    await waitFor(() => expect(engine.render).toHaveBeenCalledTimes(1));
    expect(engine.initialize.mock.calls[0][0].themeVariables.darkMode).toBe(false);
    release({ svg: '<svg id="queue-light" />' });
    await Promise.all([first, second]);
    expect(engine.initialize.mock.calls[1][0].themeVariables.darkMode).toBe(true);
  });

  it("caches source/Appearance per SVG identity, evicts errors and continues after failure", async () => {
    const instance = triuneMermaid.getMermaid();
    const first = instance.render("cache-diagram", "flowchart LR\nA-->B");
    expect(instance.render("cache-diagram", "flowchart LR\nA-->B")).toBe(first);
    await first;
    await instance.render("other-consumer", "flowchart LR\nA-->B");
    document.documentElement.style.setProperty("--primary", "#1c7455");
    await instance.render("cache-diagram", "flowchart LR\nA-->B");
    await instance.render("cache-diagram", "flowchart LR\nA-->C");
    expect(engine.render).toHaveBeenCalledTimes(4);
    engine.render.mockRejectedValueOnce(new Error("partial source"));
    await expect(instance.render("retry", "partial")).rejects.toThrow("partial source");
    await instance.render("retry", "partial");
    expect(engine.render).toHaveBeenCalledTimes(6);
  });

  it("serializes foreignObject void tags as valid SVG XML for downloads", async () => {
    engine.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">A<br>B</div></foreignObject></svg>',
    });
    const { svg } = await triuneMermaid
      .getMermaid()
      .render("download", 'flowchart LR\nA("A<br>B")');
    expect(
      new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("parsererror"),
    ).toBeNull();
    expect(svg).toContain("<br />");
  });
});
