// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, expect, it, vi } from "vitest";
import { presentMermaidSvg } from "./mermaidPresentation";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function measuredDiagram() {
  document.body.innerHTML = `<style>.cluster > rect {fill:#f0f0f0} text {fill:#222222}</style><svg viewBox="0 0 250 250">
    <g class="cluster" id="outer"><rect/><g class="cluster-label"><text>Outer</text></g></g>
    <g class="cluster" id="inner"><rect/><g class="cluster-label"><text>Inner</text></g></g>
    <g class="edgePaths"><path d="M 10 20 L 40 50"/></g>
    <g class="edgeLabels"><g class="edgeLabel" id="contained"><text>Inside</text></g>
    <g class="edgeLabel" id="crossing"><text>Crossing</text></g>
    <g class="edgeLabel" id="outside"><text>Outside</text></g></g></svg>`;
  const svg = document.querySelector("svg")!;
  const matrix = (x = 0, y = 0) => ({
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: x,
    f: y,
    inverse: () => matrix(-x, -y),
    multiply: (other: { e: number; f: number }) => matrix(x + other.e, y + other.f),
  });
  vi.stubGlobal(
    "DOMPoint",
    class {
      x: number;
      y: number;
      constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
      }
      matrixTransform(transform: { e: number; f: number }) {
        return { x: this.x + transform.e, y: this.y + transform.f };
      }
    },
  );
  Object.defineProperty(svg, "getScreenCTM", { value: () => matrix() });
  function measure(selector: string, x: number, y: number, width: number, height: number) {
    const element = svg.querySelector(selector)!;
    Object.defineProperties(element, {
      getBBox: { value: () => new DOMRect(0, 0, width, height) },
      getBoundingClientRect: { value: () => new DOMRect(x, y, width, height) },
      getScreenCTM: { value: () => matrix(x, y) },
    });
    for (const text of element.querySelectorAll("text"))
      Object.defineProperty(text, "getBoundingClientRect", {
        value: () => new DOMRect(x, y, width, height),
      });
  }
  measure("#outer > rect", 10, 10, 200, 200);
  measure("#inner > rect", 40, 40, 100, 100);
  measure("#outer > .cluster-label", 20, 14, 50, 16);
  measure("#inner > .cluster-label", 55, 44, 50, 16);
  measure("#contained", 60, 80, 30, 16);
  measure("#crossing", 128, 100, 12, 16); // Padding extends beyond the inner group.
  measure("#outside", 220, 220, 25, 16);
  return svg;
}

it("uses complete padded label containment and lifts opaque headings without changing paths", () => {
  const svg = measuredDiagram();
  const path = svg.querySelector("path")!.outerHTML;
  presentMermaidSvg(svg, {
    canvas: "#ffffff",
    foreground: "#222222",
    groups: ["#f0f0f0", "#dddddd", "#bbbbbb"],
  });
  expect(getComputedStyle(svg.querySelector("#inner > rect")!).fill).toBe("rgb(221, 221, 221)");
  expect(svg.querySelector("#contained")?.getAttribute("data-triune-label-surface")).toBe("inner");
  expect(svg.querySelector("#crossing")?.getAttribute("data-triune-label-surface")).toBe("outer");
  expect(svg.querySelector("#outside")?.getAttribute("data-triune-label-surface")).toBe("canvas");
  const heading = svg.querySelector(".triune-heading-foreground > .cluster-label")!;
  expect(heading.getAttribute("transform")).toBe("matrix(1 0 0 1 20 14)");
  expect(heading.firstElementChild?.getAttribute("fill")).toBe("#f0f0f0");
  expect(svg.lastElementChild).toHaveClass("triune-heading-foreground");
  expect(svg.querySelector("path")!.outerHTML).toBe(path);
});

it("retains an authored group fill and chooses readable heading text against that fill", () => {
  const svg = measuredDiagram();
  (svg.querySelector("#inner > rect") as SVGRectElement).style.fill = "#111111";
  presentMermaidSvg(svg, {
    canvas: "#ffffff",
    foreground: "#222222",
    groups: ["#f0f0f0", "#dddddd", "#bbbbbb"],
  });
  const heading = svg.querySelector(
    '[data-triune-label-role="heading"][data-triune-label-surface="inner"]',
  )!;
  expect(heading.firstElementChild?.getAttribute("fill")).toBe("#111111");
  expect((heading.querySelector("text") as SVGTextElement).style.fill).toBe("rgb(255, 255, 255)");
});

it("keeps authored node fills and freezes readable foregrounds for standalone SVG exports", () => {
  const svg = measuredDiagram();
  svg.insertAdjacentHTML(
    "beforeend",
    '<g class="node"><rect class="label-container" style="fill:#111111"/><g class="label"><text>Authored category</text></g></g>',
  );
  presentMermaidSvg(svg, {
    canvas: "#ffffff",
    foreground: "#222222",
    groups: ["#f0f0f0", "#dddddd", "#bbbbbb"],
  });
  expect((svg.querySelector(".label-container") as SVGRectElement).style.fill).toBe(
    "rgb(17, 17, 17)",
  );
  expect(getComputedStyle(svg.querySelector(".node text")!).fill).toBe("rgb(255, 255, 255)");
});
