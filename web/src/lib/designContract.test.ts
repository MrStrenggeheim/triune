// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { afterEach, expect, it } from "vitest";
import { getArtifactThemeVariables } from "./designContract";

afterEach(() => document.body.replaceChildren());

it("exports resolved custom palette values for an isolated artifact without inventing missing roles", () => {
  const root = document.createElement("div");
  root.style.fontFamily = '"Example UI", monospace';
  root.style.fontSize = "17px";
  root.style.setProperty("--primary", "rgb(32, 96, 128)");
  root.style.setProperty("--foreground", "rgb(240, 240, 240)");
  root.style.setProperty("--workspace-close-hover", "rgb(64, 64, 64)");
  root.style.setProperty("--focus-color", "rgb(32, 96, 128)");
  root.style.setProperty("--radius-sm", "4px");
  root.style.setProperty("--list-row-padding-block", "2px");
  document.body.append(root);
  const variables = getArtifactThemeVariables(root);
  expect(variables).toMatchObject({
    "--ta-font": '"Example UI", monospace',
    "--ta-ui": "17px",
    "--ta-primary": "rgb(32, 96, 128)",
    "--ta-text": "rgb(240, 240, 240)",
    "--ta-close-hover": "rgb(64, 64, 64)",
    "--ta-ring": "rgb(32, 96, 128)",
    "--ta-radius-sm": "4px",
    "--ta-row-y": "2px",
  });
  expect(variables).not.toHaveProperty("--ta-content");
  expect(Object.values(variables)).not.toContain("");
});
