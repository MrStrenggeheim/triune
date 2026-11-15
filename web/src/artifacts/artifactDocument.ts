// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { embedArtifactKit } from "./kitEmbedding.ts";

export const ARTIFACT_SANDBOX = "allow-scripts";

export interface ArtifactKitAssets {
  css: string;
  javascript: string;
  icons: string;
}

export interface ArtifactTheme {
  mode: "light" | "dark";
  density: "comfortable" | "compact";
  variables: Record<string, string>;
}

export interface ArtifactDocumentOptions {
  channel: string;
  kit?: ArtifactKitAssets;
  theme?: ArtifactTheme;
  state?: unknown;
  active?: boolean;
}

export interface ArtifactUpdateMessage {
  type: "triune-artifact:update";
  channel: string;
  theme?: ArtifactTheme;
  active?: boolean;
  state?: unknown;
}

export type ArtifactChildMessage =
  | { type: "triune-artifact:ready"; channel: string }
  | { type: "triune-artifact:resize"; channel: string; height: number }
  | { type: "triune-artifact:state"; channel: string; value: unknown };

const MAX_STATE_BYTES = 16_384;
const MAX_HEIGHT = 4_096;
const INNER_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; navigate-to 'none'";
const OUTER_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:; connect-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; object-src 'none'; worker-src 'none'; navigate-to 'none'";

function scriptText(value: unknown): string {
  return (JSON.stringify(value) ?? "undefined")
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeScript(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function insertIntoHead(html: string, headContent: string): string {
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${headContent}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(?:\s[^>]*)?>/i, (root) => `${root}<head>${headContent}</head>`);
  }
  return `<!doctype html><html><head>${headContent}</head><body>${html}</body></html>`;
}

function boundedInitialState(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_STATE_BYTES
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function innerBridge(channel: string, initialState: unknown, initialActive: boolean): string {
  return `(() => {
  "use strict";
  const channel = ${scriptText(channel)};
  const maxStateBytes = ${MAX_STATE_BYTES};
  const maxHeight = ${MAX_HEIGHT};
  const encoder = new TextEncoder();
  const initialState = ${scriptText(initialState)};
  let active = ${initialActive};
  let applicationState =
    initialState && typeof initialState === "object" && initialState.__triuneArtifact === 1
      ? initialState.application
      : initialState;
  let restoring = false;
  let snapshotTimer = 0;
  let frameSerial = 0;
  const queuedFrames = new Map();
  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const timeouts = new Map();

  const post = message => parent.postMessage({ ...message, channel }, "*");
  const jsonBytes = value => {
    try { return encoder.encode(JSON.stringify(value)).byteLength; } catch { return Infinity; }
  };
  const controls = () => [
    ...document.querySelectorAll("input:not([type=password]):not([type=file]),select,textarea")
  ];
  const capture = () => ({
    __triuneArtifact: 1,
    application: applicationState,
    form: controls().map(control => ({
      value: control.value,
      checked: "checked" in control ? control.checked : undefined,
      selectedIndex: "selectedIndex" in control ? control.selectedIndex : undefined
    })),
    details: [...document.querySelectorAll("details")].map(detail => detail.open),
    scroll: [scrollX, scrollY]
  });
  const publishState = () => {
    const value = capture();
    if (jsonBytes(value) <= maxStateBytes) post({ type: "triune-artifact:state", value });
  };
  const scheduleState = () => {
    if (restoring || snapshotTimer) return;
    snapshotTimer = window.setTimeout(() => { snapshotTimer = 0; publishState(); }, 0);
  };
  const restore = value => {
    restoring = true;
    if (value && typeof value === "object" && value.__triuneArtifact === 1) {
      applicationState = value.application;
      controls().forEach((control, index) => {
        const saved = value.form?.[index];
        if (!saved) return;
        if (typeof saved.value === "string") control.value = saved.value;
        if (typeof saved.checked === "boolean" && "checked" in control) control.checked = saved.checked;
        if (typeof saved.selectedIndex === "number" && "selectedIndex" in control)
          control.selectedIndex = saved.selectedIndex;
      });
      [...document.querySelectorAll("details")].forEach((detail, index) => {
        if (typeof value.details?.[index] === "boolean") detail.open = value.details[index];
      });
      if (Array.isArray(value.scroll)) scrollTo(Number(value.scroll[0]) || 0, Number(value.scroll[1]) || 0);
    } else {
      applicationState = value;
    }
    restoring = false;
  };
  const applyTheme = theme => {
    if (!theme) return;
    const roots = [...document.querySelectorAll(".ta-root,[data-triune-kit='1']")];
    roots.forEach(root => {
      root.dataset.theme = theme.mode;
      root.dataset.density = theme.density;
      for (const [name, value] of Object.entries(theme.variables || {})) {
        if (/^--ta-[a-z0-9-]+$/.test(name) && typeof value === "string")
          root.style.setProperty(name, value);
      }
    });
  };
  const setActive = value => {
    const next = value !== false;
    if (active === next) return;
    active = next;
    document.documentElement.toggleAttribute("data-ta-inactive", !active);
    window.dispatchEvent(new CustomEvent("triune-artifact:visibility", { detail: { active } }));
    if (active) {
      for (const item of timeouts.values()) {
        if (item.waiting) {
          item.waiting = false;
          item.nativeId = nativeSetTimeout(() => runTimeout(item), 0);
        }
      }
      for (const item of queuedFrames.values()) {
        if (!item.nativeId) scheduleFrame(item);
      }
    }
  };

  const scheduleFrame = item => {
    item.nativeId = nativeRequestAnimationFrame(time => {
      item.nativeId = 0;
      if (!active) return;
      queuedFrames.delete(item.id);
      item.callback(time);
    });
  };
  window.requestAnimationFrame = callback => {
    const id = ++frameSerial;
    const item = { id, callback, nativeId: 0 };
    queuedFrames.set(id, item);
    if (active) scheduleFrame(item);
    return id;
  };
  window.cancelAnimationFrame = id => {
    const item = queuedFrames.get(id);
    if (!item) return;
    queuedFrames.delete(id);
    if (item.nativeId) nativeCancelAnimationFrame(item.nativeId);
  };
  window.setInterval = (callback, delay, ...args) =>
    nativeSetInterval((...values) => {
      if (active) {
        if (typeof callback === "function") callback(...values);
      }
    }, delay, ...args);
  const runTimeout = item => {
    if (!active) { item.waiting = true; return; }
    timeouts.delete(item.id);
    if (typeof item.callback === "function") item.callback(...item.args);
  };
  window.setTimeout = (callback, delay, ...args) => {
    const item = { id: 0, nativeId: 0, callback, args, waiting: false };
    item.nativeId = nativeSetTimeout(() => runTimeout(item), delay);
    item.id = item.nativeId;
    timeouts.set(item.id, item);
    return item.id;
  };
  window.clearTimeout = id => {
    const item = timeouts.get(id);
    if (item) { nativeClearTimeout(item.nativeId); timeouts.delete(id); }
    else nativeClearTimeout(id);
  };
  window.clearInterval = id => {
    if (timeouts.has(id)) window.clearTimeout(id);
    else nativeClearInterval(id);
  };

  window.TriuneArtifactState = Object.freeze({
    get: () => applicationState,
    set: value => {
      if (jsonBytes(value) > maxStateBytes) throw new RangeError("Artifact state exceeds 16384 bytes");
      applicationState = value;
      publishState();
    }
  });

  addEventListener("message", event => {
    const message = event.data;
    if (event.source !== parent || !message || message.channel !== channel ||
        message.type !== "triune-artifact:update") return;
    applyTheme(message.theme);
    if ("state" in message) restore(message.state);
    if ("active" in message) setActive(message.active);
  });
  addEventListener("input", scheduleState, true);
  addEventListener("change", scheduleState, true);
  addEventListener("toggle", scheduleState, true);
  addEventListener("scroll", scheduleState, true);

  const ready = () => {
    document.documentElement.toggleAttribute("data-ta-inactive", !active);
    restore(initialState);
    const reportSize = () => post({
      type: "triune-artifact:resize",
      height: Math.min(maxHeight, Math.max(0, Math.ceil(document.documentElement.scrollHeight)))
    });
    new ResizeObserver(reportSize).observe(document.documentElement);
    reportSize();
    post({ type: "triune-artifact:ready" });
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();`;
}

function outerBridge(channel: string, inner: string, initial: ArtifactUpdateMessage): string {
  return `(() => {
  "use strict";
  const channel = ${scriptText(channel)};
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "Interactive artifact");
  frame.srcdoc = ${scriptText(inner)};
  document.body.append(frame);
  addEventListener("message", event => {
    const message = event.data;
    if (!message || message.channel !== channel) return;
    if (event.source === parent && message.type === "triune-artifact:update") {
      frame.contentWindow?.postMessage(message, "*");
      return;
    }
    if (event.source !== frame.contentWindow) return;
    if (message.type === "triune-artifact:ready") {
      frame.contentWindow?.postMessage(${scriptText(initial)}, "*");
      parent.postMessage(message, "*");
    } else if (message.type === "triune-artifact:resize" &&
               Number.isFinite(message.height) && message.height >= 0 && message.height <= ${MAX_HEIGHT}) {
      parent.postMessage(message, "*");
    } else if (message.type === "triune-artifact:state" &&
               (() => { try { return new TextEncoder().encode(JSON.stringify(message.value)).byteLength <= ${MAX_STATE_BYTES}; } catch { return false; } })()) {
      parent.postMessage(message, "*");
    }
  });
})();`;
}

/**
 * Builds an opaque outer document containing one opaque, script-only artifact frame.
 * Uploaded HTML is retained in full and receives no host API or origin privileges.
 */
export function buildArtifactDocument(html: string, options: ArtifactDocumentOptions): string {
  if (!options.channel) throw new TypeError("Artifact channel is required");

  const initialState = boundedInitialState(options.state);
  const embedded = options.kit ? embedArtifactKit(html, options.kit, options.theme) : html;
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${INNER_CSP}">`,
    `<script>${escapeScript(innerBridge(options.channel, initialState, options.active !== false))}</script>`,
  ].join("");
  const inner = insertIntoHead(embedded, head);
  const initial: ArtifactUpdateMessage = {
    type: "triune-artifact:update",
    channel: options.channel,
    theme: options.theme,
    active: options.active ?? true,
    state: initialState,
  };
  const outerScript = outerBridge(options.channel, inner, initial);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${OUTER_CSP}">
<style>html,body,iframe{box-sizing:border-box;width:100%;height:100%;margin:0;border:0;background:transparent}body{overflow:hidden}</style>
</head>
<body><script>${escapeScript(outerScript)}</script></body>
</html>`;
}
