// Modified for Triune.
import { useState } from "react";
import { resolveMermaidAppearance } from "@/components/ai-elements/mermaidTheme";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidPreview } from "./MermaidPreview";

let resolvedTheme = "light";
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme }),
}));
vi.mock("streamdown", () => {
  function Diagram({
    mermaid,
  }: {
    mermaid: { config: { themeVariables: { darkMode: boolean } } };
  }) {
    // Model Streamdown's mount-time async result; MermaidBlock must discard it on Appearance changes.
    const [appearance] = useState(() =>
      resolveMermaidAppearance(mermaid.config.themeVariables.darkMode ? "dark" : "light"),
    );
    return (
      <div
        data-testid="diagram"
        data-mermaid-theme={appearance.config.theme}
        data-dark={String(appearance.config.themeVariables?.darkMode)}
        data-font={appearance.config.fontFamily}
        data-size={appearance.config.fontSize}
        data-group={appearance.surfaces.groups[0]}
      />
    );
  }
  return {
    Streamdown: ({
      mermaid,
      components,
    }: {
      mermaid: Parameters<typeof Diagram>[0]["mermaid"];
      components: { pre: React.ComponentType<React.ComponentProps<"pre">> };
    }) => {
      const Pre = components.pre;
      return (
        <Pre>
          <Diagram {...{ mermaid, className: "language-mermaid" }} />
        </Pre>
      );
    },
  };
});

afterEach(() => {
  cleanup();
  resolvedTheme = "light";
  document.documentElement.removeAttribute("style");
});

describe("MermaidPreview theme", () => {
  it("passes the current app theme to Mermaid after a theme change", () => {
    const source = "flowchart LR\n  Agent --> Gateway";
    const { rerender } = render(<MermaidPreview source={source} />);
    expect(screen.getByTestId("diagram")).toHaveAttribute("data-mermaid-theme", "base");
    expect(screen.getByTestId("diagram")).toHaveAttribute("data-dark", "false");

    resolvedTheme = "dark";
    rerender(<MermaidPreview source={source} />);
    expect(screen.getByTestId("diagram")).toHaveAttribute("data-mermaid-theme", "base");
    expect(screen.getByTestId("diagram")).toHaveAttribute("data-dark", "true");
  });
  it("refreshes file/editor diagram typography and accent without replacing the preview", async () => {
    document.documentElement.style.setProperty("--primary", "#1c7455");
    render(<MermaidPreview source={"flowchart LR\n A-->B"} />);
    const preview = screen.getByTestId("mermaid-preview");
    const first = screen.getByTestId("diagram");
    const firstFill = first.getAttribute("data-group");
    document.documentElement.style.setProperty("--primary", "#aa5500");
    document.documentElement.style.setProperty("--ui-font-family", "Georgia");
    document.documentElement.style.setProperty("--text-ui", "18px");
    await waitFor(() =>
      expect(screen.getByTestId("diagram")).toHaveAttribute("data-font", "Georgia"),
    );
    expect(screen.getByTestId("diagram")).toHaveAttribute("data-size", "18");
    expect(screen.getByTestId("diagram").getAttribute("data-group")).not.toBe(firstFill);
    expect(screen.getByTestId("diagram")).not.toBe(first);
    expect(screen.getByTestId("mermaid-preview")).toBe(preview);
  });
});
