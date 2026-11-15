import { describe, expect, it } from "vitest";
import {
  ARTIFACT_SANDBOX,
  buildArtifactDocument,
  type ArtifactDocumentOptions,
} from "./artifactDocument";

function innerDocument(outer: string): string {
  const match = /frame\.srcdoc = (".*?");\n  document\.body\.append/s.exec(outer);
  if (!match) throw new Error("inner srcdoc assignment missing");
  return JSON.parse(match[1]) as string;
}

const options: ArtifactDocumentOptions = {
  channel: "artifact:test",
  theme: {
    mode: "dark",
    density: "compact",
    variables: { "--ta-primary": "#123456", "--not-artifact": "ignored" },
  },
  active: false,
  state: { count: 2 },
};

describe("buildArtifactDocument", () => {
  it("builds opaque nested sandbox and deny-by-default network policies", () => {
    const outer = buildArtifactDocument("<button>Run</button>", options);
    const inner = innerDocument(outer);

    expect(ARTIFACT_SANDBOX).toBe("allow-scripts");
    expect(outer).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    expect(outer).not.toContain("allow-same-origin");
    expect(outer).not.toContain("allow-popups");
    expect(outer).toContain("</script>");
    expect(outer).not.toContain("<\\/script>");
    expect(outer).toContain("frame-src about:");
    expect(outer).toContain("img-src data: blob:");
    expect(outer).toContain("media-src data: blob:");
    expect(outer).toContain("font-src data:");
    expect(outer).toContain("connect-src 'none'");
    expect(inner).toContain("default-src 'none'");
    expect(inner).toContain("img-src data: blob:");
    expect(inner).toContain("form-action 'none'");
    expect(inner).toContain("frame-src 'none'");
    expect(inner).toContain("worker-src 'none'");
    expect(inner).not.toContain("allow-same-origin");
  });

  it("keeps the complete uploaded document, including a large interactive tail", () => {
    const padding = "x".repeat(760 * 1024);
    const tail = '<button id="tail" onclick="this.dataset.hit=\'1\'">Tail</button>';
    const inner = innerDocument(
      buildArtifactDocument(`<!doctype html><html><body>${padding}${tail}</body></html>`, options),
    );

    expect(inner.length).toBeGreaterThan(740 * 1024);
    expect(inner).toContain(padding);
    expect(inner).toContain(tail);
    expect(inner.indexOf(tail)).toBeGreaterThan(inner.indexOf(padding));
  });

  it("injects kit assets only when markup opts into the kit", () => {
    const kit = {
      css: ".ta-root{color:red}",
      javascript: "window.kitLoaded=true;",
      icons: '<svg id="kit-icons"></svg>',
    };
    const plain = innerDocument(
      buildArtifactDocument("<main>Plain</main>", { channel: "plain", kit }),
    );
    const optedIn = innerDocument(
      buildArtifactDocument('<main class="ta-root">Kit</main>', { channel: "kit", kit }),
    );
    const attributeOptIn = innerDocument(
      buildArtifactDocument('<main data-triune-kit="1">Kit</main>', {
        channel: "kit-attribute",
        kit,
      }),
    );

    expect(plain).not.toContain(".ta-root{color:red}");
    expect(plain).not.toContain("kitLoaded");
    expect(optedIn).toContain(".ta-root{color:red}");
    expect(optedIn).toContain("window.kitLoaded=true");
    expect(optedIn).toContain('id="kit-icons"');
    expect(attributeOptIn).toContain(".ta-root{color:red}");
  });

  it("uses a source-and-channel-bound narrow bridge", () => {
    const outer = buildArtifactDocument('<main class="ta-root"></main>', options);
    const inner = innerDocument(outer);

    expect(outer).toContain("event.source === parent");
    expect(outer).toContain("event.source !== frame.contentWindow");
    expect(outer).toContain('message.type === "triune-artifact:update"');
    expect(outer).toContain('message.type === "triune-artifact:ready"');
    expect(outer).toContain('message.type === "triune-artifact:resize"');
    expect(outer).toContain('message.type === "triune-artifact:state"');
    expect(inner).toContain("event.source !== parent");
    expect(inner).toContain("message.channel !== channel");
    expect(inner).toContain("height: Math.min(maxHeight");
    expect(inner).toContain("Artifact state exceeds 16384 bytes");
  });

  it("provides bounded state restoration and cooperative inactive behavior", () => {
    const inner = innerDocument(
      buildArtifactDocument("<form><input></form><details></details>", options),
    );

    expect(inner).toContain("window.TriuneArtifactState");
    expect(inner.indexOf("const initialState")).toBeLessThan(inner.indexOf(uploadedMarker()));
    expect(inner).toContain("application: applicationState");
    expect(inner).toContain("input:not([type=password]):not([type=file]),select,textarea");
    expect(inner).toContain('document.querySelectorAll("details")');
    expect(inner).toContain("scroll: [scrollX, scrollY]");
    expect(inner).toContain("window.requestAnimationFrame = callback");
    expect(inner).toContain("window.setInterval = (callback");
    expect(inner).toContain('"triune-artifact:visibility"');
    expect(inner).not.toContain("Function(callback)");
  });

  it("escapes script terminators without truncating uploaded source", () => {
    const uploaded = '<script>window.tail = "</script-safe>"</script><p>after</p>';
    const outer = buildArtifactDocument(uploaded, { channel: "</script><script>bad()</script>" });
    const inner = innerDocument(outer);

    expect(inner).toContain(uploaded);
    expect(outer).not.toContain("<script>bad()</script>");
    expect(inner).toContain("<p>after</p>");
  });

  it("rejects a missing channel and omits oversized initial state", () => {
    expect(() => buildArtifactDocument("x", { channel: "" })).toThrow("channel is required");

    const outer = buildArtifactDocument("x", {
      channel: "bounded",
      state: "x".repeat(17_000),
    });
    expect(outer).not.toContain("x".repeat(17_000));
  });
});

function uploadedMarker(): string {
  return "<form><input>";
}
