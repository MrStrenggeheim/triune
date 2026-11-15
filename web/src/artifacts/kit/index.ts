// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { DESIGN_CONTRACT_VERSION } from "../../lib/designContract";
import css from "./triune-artifact.css?raw";
import javascript from "./triune-artifact.js?raw";
import icons from "./triune-icons.svg?raw";
import manifest from "./manifest.json?raw";

export const artifactKit = {
  id: "triune-artifact",
  version: DESIGN_CONTRACT_VERSION,
  css,
  javascript,
  icons,
  manifest,
} as const;
