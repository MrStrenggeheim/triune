// Keep Shiki core and engines together to avoid initialization cycles.
// Leave language, theme and WASM data behind their dynamic imports.
export function shikiManualChunk(id: string): string | undefined {
  const normalized = id.replaceAll("\\", "/");
  if (
    normalized.includes("/@shikijs/langs/") ||
    normalized.includes("/@shikijs/themes/") ||
    normalized.endsWith("/shiki/dist/wasm.mjs") ||
    normalized.endsWith("/@shikijs/engine-oniguruma/dist/wasm-inlined.mjs")
  ) {
    return undefined;
  }
  if (normalized.includes("/shiki") || normalized.includes("/@shikijs/")) return "shiki";
  return undefined;
}
