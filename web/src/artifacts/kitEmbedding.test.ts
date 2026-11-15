// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import { buildArtifactDocument } from "./artifactDocument";
import { embedArtifactKit } from "./kitEmbedding";

it("exports an opt-in document with local kit assets exactly once for ordinary HTML viewers", () => {
  const kit = {
    css: ".ta-root{color:var(--ta-primary)}",
    javascript: "window.TriuneArtifact={init(){}}",
    icons: "<svg id=icons></svg>",
  };
  const html =
    '<!doctype html><html><head><title>Local</title></head><body><main data-triune-kit="1">Tool</main></body></html>';
  const complete = embedArtifactKit(html, kit, {
    mode: "dark",
    density: "compact",
    variables: { "--ta-ui": "17px" },
  });
  expect(complete).toContain('<style data-triune-kit-embedded="1">');
  expect(complete).toContain("--ta-ui");
  expect(complete).toContain("window.TriuneArtifact?.init(root)");
  expect(embedArtifactKit(complete, kit)).toBe(complete);
  const framed = buildArtifactDocument(complete, { channel: "export", kit });
  const encoded = framed.match(/frame\.srcdoc = (".*?");\n  document\.body\.append/s)![1];
  const inner = JSON.parse(encoded) as string;
  expect(inner.match(/data-triune-kit-embedded="1"/g)).toHaveLength(1);
  expect(inner.match(/window.TriuneArtifact=\{init\(\)\{\}\}/g)).toHaveLength(1);
  expect(embedArtifactKit("<p>Ordinary HTML</p>", kit)).toBe("<p>Ordinary HTML</p>");
});
