// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ArtifactKitAssets, ArtifactTheme } from "./artifactDocument";

export function usesArtifactKit(html: string): boolean {
  return (
    /<[^>]+\bdata-triune-kit\s*=\s*(?:"1"|'1'|1)(?:\s|\/?>)/i.test(html) ||
    /<[^>]+\bclass\s*=\s*(?:"[^"]*\bta-root\b[^"]*"|'[^']*\bta-root\b[^']*')/i.test(html)
  );
}

/** Embed once so the resulting file opens through ordinary HTML viewers without a kit fetch. */
export function embedArtifactKit(
  html: string,
  kit: ArtifactKitAssets,
  theme?: ArtifactTheme,
): string {
  if (!usesArtifactKit(html) || /data-triune-kit-embedded\s*=\s*["']?1/i.test(html)) return html;
  const css = `<style data-triune-kit-embedded="1">${kit.css.replace(/<\/style/gi, "<\\/style")}</style>`;
  const configuration = JSON.stringify(theme ?? null).replaceAll("<", "\\u003c");
  const initialize = `document.querySelectorAll('.ta-root,[data-triune-kit="1"]').forEach(root=>{root.classList.add('ta-root');const theme=${configuration};if(theme){root.dataset.theme=theme.mode;root.dataset.density=theme.density;for(const [name,value]of Object.entries(theme.variables)){if(/^--ta-[a-z0-9-]+$/.test(name)&&typeof value==='string')root.style.setProperty(name,value);}}window.TriuneArtifact?.init(root);});`;
  const runtime = `${kit.icons}<script data-triune-kit-helper="1">${kit.javascript.replace(/<\/script/gi, "<\\/script")}\n${initialize}</script>`;
  let result: string;
  if (/<head(?:\s[^>]*)?>/i.test(html))
    result = html.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${css}`);
  else if (/<html(?:\s[^>]*)?>/i.test(html))
    result = html.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${css}</head>`);
  else
    result = `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>${html}</body></html>`;
  const end = result.toLowerCase().lastIndexOf("</body>");
  return end >= 0 ? result.slice(0, end) + runtime + result.slice(end) : result + runtime;
}
