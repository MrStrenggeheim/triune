// PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

function channels(color: string): number[] {
  return color
    .slice(1)
    .match(/../g)!
    .map((channel) => parseInt(channel, 16));
}

export function mixMermaidColor(accent: string, background: string, weight: number): string {
  const base = channels(background);
  return (
    "#" +
    channels(accent)
      .map((value, index) =>
        Math.round(value * weight + base[index] * (1 - weight))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

export function mermaidContrast(first: string, second: string): number {
  const luminance = (color: string) =>
    channels(color)
      .map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function mermaidTextOn(fill: string, preferred: string, alternate: string): string {
  for (const candidate of [preferred, alternate]) {
    if (mermaidContrast(candidate, fill) >= 4.5) return candidate;
  }
  return mermaidContrast("#ffffff", fill) >= mermaidContrast("#000000", fill)
    ? "#ffffff"
    : "#000000";
}

export function mermaidBoundary(color: string, surfaces: string[], foreground: string): string {
  for (const target of [foreground, "#000000", "#ffffff"]) {
    for (let step = 0; step <= 100; step++) {
      const candidate = mixMermaidColor(target, color, step / 100);
      if (surfaces.every((surface) => mermaidContrast(candidate, surface) >= 3.15))
        return candidate;
    }
  }
  throw new Error("Mermaid surfaces cannot share a contrasting boundary");
}

function computedHex(color: string, background = "#ffffff"): string {
  if (color === "none" || color === "transparent") return background;
  if (/^#[\da-f]{6}$/i.test(color)) return color.toLowerCase();
  const values = color.match(/[\d.]+/g)?.map(Number);
  if (color.startsWith("rgb") && values && values.length >= 3) {
    const hex =
      "#" +
      values
        .slice(0, 3)
        .map((value) => Math.round(value).toString(16).padStart(2, "0"))
        .join("");
    return mixMermaidColor(hex, background, values[3] ?? 1);
  }
  // Authored CSS may use wide-gamut colors just like Appearance tokens.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !CSS.supports("color", color))
    throw new Error(`Unexpected Mermaid SVG color: ${color}`);
  context.fillStyle = background;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return (
    "#" +
    [...context.getImageData(0, 0, 1, 1).data]
      .slice(0, 3)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")
  );
}

function contains(outer: DOMRect, inner: DOMRect): boolean {
  return (
    inner.left >= outer.left - 0.01 &&
    inner.top >= outer.top - 0.01 &&
    inner.right <= outer.right + 0.01 &&
    inner.bottom <= outer.bottom + 0.01
  );
}

export interface MermaidSurfaces {
  canvas: string;
  foreground: string;
  groups: string[];
}

function readableLabel(label: Element, fill: string, surfaces: MermaidSurfaces): void {
  const elements = [label, ...label.querySelectorAll("text,tspan,foreignObject *")];
  for (const element of elements) {
    const html = element.namespaceURI === "http://www.w3.org/1999/xhtml";
    if (!html && !element.matches("text,tspan")) continue;
    const style = getComputedStyle(element);
    const color = computedHex(html ? style.color : style.fill, fill);
    const foreground = mermaidTextOn(fill, color, surfaces.foreground);
    const target = element as SVGElement | HTMLElement;
    target.style.setProperty("color", foreground, "important");
    target.style.setProperty("fill", foreground, "important");
    target.style.setProperty("background", "transparent", "important");
  }
}

function presentNodeLabels(svg: SVGSVGElement, surfaces: MermaidSurfaces): void {
  for (const node of svg.querySelectorAll(".node")) {
    const container = node.querySelector<SVGElement>(".label-container,.node-bkg");
    const label = node.querySelector(".label");
    if (!container || !label) continue;
    const shapes = container.matches("g")
      ? [...container.querySelectorAll<SVGElement>("rect,path,circle,ellipse,polygon")]
      : [container];
    const shape = shapes.find((shape) => getComputedStyle(shape).fill !== "none");
    const bounds = label.getBoundingClientRect();
    const point = new DOMRect(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 0, 0);
    const group = [...svg.querySelectorAll<SVGRectElement>(".cluster > rect")]
      .filter((rect) => contains(rect.getBoundingClientRect(), point))
      .sort(
        (a, b) =>
          a.getBoundingClientRect().width * a.getBoundingClientRect().height -
          b.getBoundingClientRect().width * b.getBoundingClientRect().height,
      )[0];
    const background = group
      ? computedHex(getComputedStyle(group).fill, surfaces.canvas)
      : surfaces.canvas;
    const style = shape ? getComputedStyle(shape) : null;
    const fill = style
      ? mixMermaidColor(
          computedHex(style.fill, background),
          background,
          Number(style.fillOpacity || 1),
        )
      : background;
    readableLabel(label, fill, surfaces);
  }
  const vennPaths = [...svg.querySelectorAll<SVGPathElement>(".venn-area > path")];
  for (const label of svg.querySelectorAll<SVGTextElement>(".venn-area > text")) {
    const bounds = label.getBoundingClientRect();
    let fill = surfaces.canvas;
    for (const path of vennPaths) {
      const matrix = path.getScreenCTM();
      if (
        !matrix ||
        !path.isPointInFill(
          new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).matrixTransform(
            matrix.inverse(),
          ),
        )
      )
        continue;
      const style = getComputedStyle(path);
      fill = mixMermaidColor(
        computedHex(style.fill, fill),
        fill,
        Number(style.fillOpacity) * Number(style.opacity),
      );
    }
    readableLabel(label, fill, surfaces);
  }
}

/** C4 11.16.1 hardcodes foregrounds and connectors outside its configuration. */
function presentC4Svg(svg: SVGSVGElement, surfaces: MermaidSurfaces): void {
  if (!svg.querySelector(".person-man")) return;
  const outline = mermaidBoundary(
    surfaces.foreground,
    [surfaces.canvas, ...surfaces.groups],
    surfaces.foreground,
  );
  for (const group of svg.querySelectorAll<SVGGElement>(".person-man")) {
    const shape = group.querySelector<SVGElement>(
      'rect[fill]:not([fill="none"]),path[fill]:not([fill="none"])',
    );
    if (!shape) continue;
    const fill = computedHex(getComputedStyle(shape).fill);
    for (const text of group.querySelectorAll<SVGTextElement>('text[fill="#FFFFFF"]')) {
      text.style.fill = mermaidTextOn(fill, surfaces.foreground, surfaces.canvas);
    }
  }
  for (const element of svg.querySelectorAll<SVGElement>('[stroke="#444444"],[stroke="#000000"]'))
    element.style.stroke = outline;
  for (const text of svg.querySelectorAll<SVGTextElement>(
    'text[fill="#444444"],text[fill="black"]',
  ))
    text.style.fill = surfaces.foreground;
  for (const marker of svg.querySelectorAll<SVGElement>("marker path")) {
    if (getComputedStyle(marker).fill !== "none") marker.style.fill = outline;
  }
}

/** Presentation of strict-sanitized Mermaid 11.16.1 output; never changes paths or node shapes. */
export function presentMermaidSvg(svg: SVGSVGElement, surfaces: MermaidSurfaces): void {
  const viewBox = svg
    .getAttribute("viewBox")
    ?.split(/[\s,]+/)
    .map(Number);
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite)) return;
  svg.style.maxWidth = "none";
  svg.setAttribute("width", String(viewBox[2]));
  svg.setAttribute("height", String(viewBox[3]));
  svg.style.backgroundColor = surfaces.canvas;
  presentC4Svg(svg, surfaces);
  const clusters = [...svg.querySelectorAll<SVGRectElement>(".cluster > rect")].map((rect) => ({
    rect,
    id: rect.parentElement!.id,
    bounds: rect.getBoundingClientRect(),
    fill: getComputedStyle(rect).fill,
  }));
  clusters.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height);
  // Geometric containment works for nested SVG groups and Dagre's flat cluster list.
  for (const cluster of clusters) {
    const parents = clusters.filter(
      (parent) =>
        parent !== cluster &&
        parent.bounds.width * parent.bounds.height > cluster.bounds.width * cluster.bounds.height &&
        contains(parent.bounds, cluster.bounds),
    );
    const depth = parents.length;
    const background = parents.at(-1)?.fill ?? surfaces.canvas;
    cluster.fill = computedHex(cluster.fill, background);
    const fillOpacity = Number(getComputedStyle(cluster.rect).fillOpacity || 1);
    cluster.fill = mixMermaidColor(cluster.fill, background, fillOpacity);
    if (!cluster.rect.style.fill && cluster.fill === surfaces.groups[0]) {
      cluster.fill = surfaces.groups[Math.min(depth, surfaces.groups.length - 1)];
      cluster.rect.style.setProperty("fill", cluster.fill, "important");
    }
  }
  presentNodeLabels(svg, surfaces);
  clusters.sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
  const rootMatrix = svg.getScreenCTM();
  if (!rootMatrix) throw new Error("Cannot measure Mermaid SVG label surfaces");
  const namespace = "http://www.w3.org/2000/svg";
  const headings = [...svg.querySelectorAll<SVGGElement>(".cluster > .cluster-label")];
  const overlay = document.createElementNS(namespace, "g");
  overlay.setAttribute("class", "triune-heading-foreground");
  function backing(label: SVGGElement, heading: boolean): void {
    const bounds = label.getBBox(),
      matrix = label.getScreenCTM();
    if (!matrix || !bounds.width || !bounds.height) return;
    const paddingX = 3,
      paddingY = 2;
    const corners = [
      [bounds.x - paddingX, bounds.y - paddingY],
      [bounds.x + bounds.width + paddingX, bounds.y - paddingY],
      [bounds.x - paddingX, bounds.y + bounds.height + paddingY],
      [bounds.x + bounds.width + paddingX, bounds.y + bounds.height + paddingY],
    ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
    const padded = new DOMRect(
      Math.min(...corners.map((point) => point.x)),
      Math.min(...corners.map((point) => point.y)),
      Math.max(...corners.map((point) => point.x)) - Math.min(...corners.map((point) => point.x)),
      Math.max(...corners.map((point) => point.y)) - Math.min(...corners.map((point) => point.y)),
    );
    const owner = heading
      ? clusters.find((group) => group.id === label.parentElement!.id)
      : clusters.find((group) => contains(group.bounds, padded));
    const fill = owner?.fill ?? surfaces.canvas;
    // Freeze inherited foregrounds before moving headings out of their cluster.
    readableLabel(label, fill, surfaces);
    for (const rect of label.querySelectorAll<SVGRectElement>("rect")) {
      rect.style.setProperty("fill", "none", "important");
    }
    const rect = document.createElementNS(namespace, "rect");
    rect.setAttribute("class", "triune-label-background");
    for (const [name, value] of Object.entries({
      x: bounds.x - paddingX,
      y: bounds.y - paddingY,
      width: bounds.width + paddingX * 2,
      height: bounds.height + paddingY * 2,
      fill,
      stroke: "none",
      "pointer-events": "none",
      "aria-hidden": "true",
    }))
      rect.setAttribute(name, String(value));
    rect.style.cssText = `fill:${fill} !important;fill-opacity:1 !important;opacity:1 !important;stroke:none !important`;
    label.insertBefore(rect, label.firstChild);
    label.dataset.triuneLabelSurface = owner?.id ?? "canvas";
    label.dataset.triuneLabelRole = heading ? "heading" : "edge";
    if (heading) {
      const transform = rootMatrix!.inverse().multiply(matrix);
      label.setAttribute(
        "transform",
        `matrix(${transform.a} ${transform.b} ${transform.c} ${transform.d} ${transform.e} ${transform.f})`,
      );
      overlay.appendChild(label);
    }
  }
  for (const label of svg.querySelectorAll<SVGGElement>(".edgeLabels > g.edgeLabel"))
    backing(label, false);
  for (const label of headings) backing(label, true);
  if (headings.length) svg.appendChild(overlay);

  // Some families omit label extents from their viewBox; grow the canvas, never their geometry.
  const inverse = rootMatrix.inverse();
  let [left, top, width, height] = viewBox;
  let right = left + width,
    bottom = top + height;
  for (const label of svg.querySelectorAll<SVGGraphicsElement>(
    "text,foreignObject,.triune-label-background",
  )) {
    if (!label.textContent?.trim() && !label.classList.contains("triune-label-background"))
      continue;
    const bounds = label.getBoundingClientRect();
    for (const [x, y] of [
      [bounds.left, bounds.top],
      [bounds.right, bounds.bottom],
    ]) {
      const point = new DOMPoint(x, y).matrixTransform(inverse);
      left = Math.min(left, point.x - 3);
      top = Math.min(top, point.y - 3);
      right = Math.max(right, point.x + 3);
      bottom = Math.max(bottom, point.y + 3);
    }
  }
  width = right - left;
  height = bottom - top;
  svg.setAttribute("viewBox", [left, top, width, height].join(" "));
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
}

/** XMLSerializer supplies element namespaces and closes XHTML void tags for standalone downloads. */
export function serializeMermaidSvg(svg: SVGSVGElement): string {
  for (const element of [svg, ...svg.querySelectorAll("[xmlns]")]) {
    if (element.getAttributeNode("xmlns")?.namespaceURI === null) element.removeAttribute("xmlns");
  }
  return new XMLSerializer().serializeToString(svg);
}
