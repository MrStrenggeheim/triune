import { describe, expect, it } from "vitest";

import { shikiManualChunk } from "../../../vite.shiki";

const dependencyRoot = "/repo/node_modules/.pnpm/package@4.5.0/node_modules/";

// These payloads have dynamic import boundaries; grouping them with the
// statically reachable core makes plain pages download every theme and WASM.
const lazyData = [
  "@shikijs/langs/dist/typescript.mjs",
  "@shikijs/themes/dist/github-dark.mjs",
  "shiki/dist/wasm.mjs",
  "@shikijs/engine-oniguruma/dist/wasm-inlined.mjs",
];
const coreAndEngines = [
  "shiki/dist/index.mjs",
  "shiki/dist/core.mjs",
  "shiki/dist/bundle-full.mjs",
  "@shikijs/core/dist/index.mjs",
  "@shikijs/engine-oniguruma/dist/index.mjs",
  "@shikijs/engine-javascript/dist/index.mjs",
  "@shikijs/vscode-textmate/dist/index.js",
  "@shikijs/monaco/dist/index.mjs",
];

describe("shikiManualChunk", () => {
  it.each(lazyData)("preserves the dynamic data boundary for %s", (module) => {
    expect(shikiManualChunk(dependencyRoot + module)).toBeUndefined();
    expect(shikiManualChunk((dependencyRoot + module).replaceAll("/", "\\"))).toBeUndefined();
  });

  it.each(coreAndEngines)("keeps core and engine initialization together for %s", (module) => {
    expect(shikiManualChunk(dependencyRoot + module)).toBe("shiki");
    expect(shikiManualChunk((dependencyRoot + module).replaceAll("/", "\\"))).toBe("shiki");
  });

  it("leaves unrelated modules to the bundler", () => {
    expect(shikiManualChunk("/repo/web/src/App.tsx")).toBeUndefined();
    expect(shikiManualChunk(dependencyRoot + "streamdown/dist/index.js")).toBeUndefined();
  });
});
