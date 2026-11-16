// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
/** App and native artifact roles share values; adapters declare their behavior separately. */
export const DESIGN_CONTRACT_VERSION = "1.0.0";

export const DESIGN_RADII = { sm: 4, md: 6, lg: 8, tooltip: 7 } as const;

export const DESIGN_SEMANTIC_TOKENS = {
  success: "#2ea65c",
  warning: "#d4972a",
  info: "#3b8ff5",
  destructive: "#c8324c",
} as const;
export const DESIGN_DARK_SEMANTIC_TOKENS = { destructive: "#e65b77" } as const;

export const CONTROL_FOCUS_CLASS =
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Named focus exception: retain the composer's original textarea-focus shadow. */
export const COMPOSER_FOCUS_CLASS = "has-[textarea:focus]:shadow-[var(--composer-shadow-focus)]";

export const DESIGN_ROLES = {
  "workspace-content": "#ffffff",
  "workspace-chrome": "color-mix(in srgb, var(--brand-accent) 10%, var(--workspace-content))",
  "workspace-selected": "color-mix(in srgb, var(--brand-accent) 28%, var(--workspace-content))",
  "workspace-appbar": "var(--workspace-selected)",
  "workspace-group": "var(--muted)",
  "workspace-hover-on-content":
    "color-mix(in srgb, var(--brand-accent) 8%, var(--workspace-content))",
  "workspace-hover-on-chrome": "color-mix(in srgb, var(--foreground) 6%, var(--workspace-chrome))",
  "workspace-control-hover": "var(--muted)",
  "workspace-control-active": "color-mix(in srgb, var(--foreground) 10%, var(--workspace-group))",
  "workspace-close-hover":
    "color-mix(in srgb, var(--foreground) 12%, var(--workspace-hover-on-content))",
  "workspace-close-active":
    "color-mix(in srgb, var(--foreground) 18%, var(--workspace-hover-on-content))",
  "primary-hover": "color-mix(in srgb, var(--primary) 95%, black)",
  "primary-active": "color-mix(in srgb, var(--primary) 90%, black)",
  "secondary-hover": "color-mix(in srgb, var(--secondary-foreground) 6%, var(--secondary))",
  "secondary-active": "color-mix(in srgb, var(--secondary-foreground) 10%, var(--secondary))",
  "focus-color": "var(--primary)",
} as const;

export const DESIGN_DARK_ROLES = {
  "workspace-content": "#18181b",
  "workspace-control-hover": "color-mix(in srgb, var(--muted) 50%, transparent)",
} as const;

export const DENSITY_TOKENS = {
  comfortable: {
    "density-header-height": 48,
    "list-row-min-height": 36,
    "list-row-padding-block": 6,
    "list-row-padding-inline": 10,
    "list-row-gap": 8,
    "list-gap": 4,
    "tree-indent": 18,
    "popup-inset": 12,
    "popup-item-gap": 8,
    "popup-text-gap": 4,
    "popup-footer-gap": 8,
  },
  compact: {
    "density-header-height": 36,
    "list-row-min-height": 28,
    "list-row-padding-block": 2,
    "list-row-padding-inline": 8,
    "list-row-gap": 6,
    "list-gap": 2,
    "tree-indent": 14,
    "popup-inset": 8,
    "popup-item-gap": 6,
    "popup-text-gap": 4,
    "popup-footer-gap": 6,
  },
} as const;

export const ARTIFACT_TOKEN_ALIASES = {
  "--ta-font": "font-family",
  "--ta-ui": "font-size",
  "--ta-primary": "--primary",
  "--ta-primary-foreground": "--primary-foreground",
  "--ta-brand": "--brand-accent",
  "--ta-content": "--workspace-content",
  "--ta-text": "--foreground",
  "--ta-muted": "--muted-foreground",
  "--ta-secondary": "--secondary",
  "--ta-border": "--border",
  "--ta-success": "--success",
  "--ta-warning": "--warning",
  "--ta-error": "--destructive",
  "--ta-info": "--info",
  "--ta-ring": "--focus-color",
  "--ta-chrome": "--workspace-chrome",
  "--ta-appbar": "--workspace-appbar",
  "--ta-selected": "--workspace-selected",
  "--ta-control-surface": "--workspace-group",
  "--ta-hover": "--workspace-hover-on-content",
  "--ta-hover-chrome": "--workspace-hover-on-chrome",
  "--ta-control-hover": "--workspace-control-hover",
  "--ta-control-active": "--workspace-control-active",
  "--ta-close-hover": "--workspace-close-hover",
  "--ta-close-active": "--workspace-close-active",
  "--ta-primary-hover": "--primary-hover",
  "--ta-primary-active": "--primary-active",
  "--ta-secondary-hover": "--secondary-hover",
  "--ta-secondary-active": "--secondary-active",
  "--ta-radius-sm": "--radius-sm",
  "--ta-radius-md": "--radius-md",
  "--ta-radius-lg": "--radius-lg",
  "--ta-radius-tooltip": "--radius-tooltip",
  "--ta-radius-base": "--radius",
  "--ta-radius-4xl": "--radius-4xl",
  "--ta-row-min": "--list-row-min-height",
  "--ta-row-y": "--list-row-padding-block",
  "--ta-row-x": "--list-row-padding-inline",
} as const;

/** Read the host reading surface, including Appearance typography, rather than the fixed 16px rem root. */
export function getArtifactThemeVariables(root: Element): Record<string, string> {
  const style = root.ownerDocument.defaultView!.getComputedStyle(root);
  return Object.fromEntries(
    Object.entries(ARTIFACT_TOKEN_ALIASES)
      .map(([alias, token]) => [alias, style.getPropertyValue(token).trim()])
      .filter(([, value]) => value),
  );
}

export const DESIGN_COMPONENTS = {
  button: { export: "Button", module: "@/components/ui/button", radii: [8, 6, 4] },
  field: { export: "Input", module: "@/components/ui/input", radii: [8] },
  textarea: { export: "Textarea", module: "@/components/ui/textarea", radii: [8] },
  checkbox: { export: "Checkbox", module: "@/components/ui/checkbox", radii: [4] },
  select: { export: "SelectTrigger", module: "@/components/ui/select", radii: [8, 6] },
  headerAction: {
    export: "HeaderActionButton",
    module: "@/components/HeaderActionButton",
    radii: [6],
  },
  close: { export: "CloseButton", module: "@/components/CloseButton", radii: [4] },
} as const;

export const DESIGN_EXCEPTIONS = {
  badge: { module: "@/components/ui/badge", shape: "20.8px pill" },
  tooltip: { module: "@/components/ui/tooltip", radius: DESIGN_RADII.tooltip },
  switch: { module: "@/components/ui/switch", shape: "native toggle capsule" },
  selectPopup: { module: "@/components/ui/select", radius: 12 },
  dialog: { module: "@/components/ui/dialog", radius: 30 },
} as const;
