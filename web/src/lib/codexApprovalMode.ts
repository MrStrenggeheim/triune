// Last native-observed permission configuration for subsequent Codex turns.
export interface CodexRuntimeApprovalPreset {
  value: string;
  label: string;
  description: string;
}

/** Label written from native-observed future-turn permission settings. */
export const CODEX_NATIVE_APPROVAL_MODE_LABEL_KEY =
  "omnigent.codex_native.next_turn_permissions_v1";

/**
 * Built-in future-turn presets; the runner checks native profile availability.
 */
export const CODEX_NATIVE_RUNTIME_APPROVAL_PRESETS: CodexRuntimeApprovalPreset[] = [
  {
    value: "ask-for-approval",
    label: "Ask for approval",
    description: "Read/edit/run in the workspace; approval for the internet or external edits",
  },
  {
    value: "approve-for-me",
    label: "Approve for me",
    description: "Only asks for actions detected as potentially unsafe",
  },
  {
    value: "full-access",
    label: "Full Access",
    description: "Edit any file and access the internet without approval",
  },
  {
    value: "read-only",
    label: "Read Only",
    description: "Read files only; approval required for changes",
  },
];

// Read Only is also a structured native permission profile.
const CODEX_NATIVE_READ_ONLY_LABEL = "Read Only";

/** Human label for an approval-mode value, falling back to the raw value. */
export function codexApprovalModeLabel(mode: string | null | undefined): string {
  if (!mode) return "";
  if (mode === "read-only") return CODEX_NATIVE_READ_ONLY_LABEL;
  return CODEX_NATIVE_RUNTIME_APPROVAL_PRESETS.find((m) => m.value === mode)?.label ?? mode;
}

/**
 * Last observed subsequent-turn permission setting, or null when unknown.
 *
 * Reads only native observations, including the initial subscription snapshot.
 * PATCH acceptance alone never changes this label, and launch arguments are
 * not used to guess a value. Custom or unknown native profiles have no label.
 */
export function codexApprovalModeFromSession(
  session: { labels?: Record<string, string | null> | null } | null | undefined,
): string | null {
  const labelled = session?.labels?.[CODEX_NATIVE_APPROVAL_MODE_LABEL_KEY];
  return typeof labelled === "string" && labelled ? labelled : null;
}

export const CODEX_NEXT_TURN_PROTOCOL = "codex-next-turn-permissions/v1";
export const CODEX_NEXT_TURN_PATH = "/codex/next-turn-permissions/v1";
