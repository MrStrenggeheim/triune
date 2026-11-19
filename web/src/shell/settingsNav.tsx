// Modified for Triune.
import {
  ArchiveIcon,
  BlocksIcon,
  BotIcon,
  DownloadIcon,
  GitBranchIcon,
  KeyboardIcon,
  PaletteIcon,
  PlugIcon,
  SettingsIcon,
  Share2Icon,
  ShieldCheckIcon,
  TerminalIcon,
  UserCogIcon,
  UsersIcon,
  VectorSquareIcon,
} from "lucide-react";
import { Link, useLocation } from "@/lib/routing";

import { useServerInfo } from "@/lib/CapabilitiesContext";
import { customAgentsSettingsEnabled, isSingleUserMode } from "@/lib/capabilities";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { isElectronShell, supportsNativeServerPicker } from "@/lib/nativeBridge";
import { cn } from "@/lib/utils";
import { SidebarNavAction } from "./SidebarHeaderActions";
import { SidebarServerPicker } from "./SidebarServerPicker";

export type SettingsSectionId =
  | "appearance"
  | "harnesses"
  | "custom-agents"
  | "general"
  | "git"
  | "integrations"
  | "mcp"
  | "shortcuts"
  | "import"
  | "account"
  | "members"
  | "policies"
  | "sharing"
  | "archived"
  | "cli"
  | "updates";

const SECTION_IDS: readonly SettingsSectionId[] = [
  "appearance",
  "harnesses",
  "custom-agents",
  "general",
  "git",
  "integrations",
  "mcp",
  "shortcuts",
  "import",
  "account",
  "members",
  "policies",
  "sharing",
  "archived",
  "cli",
  "updates",
];

interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  icon: typeof PaletteIcon;
  /** Hide this item on mobile (e.g. keyboard shortcuts on a touch device). */
  hideOnMobile?: boolean;
}

interface SettingsNavGroup {
  title: string;
  items: SettingsNavItem[];
}

/**
 * Nav groups for the current deploy. The Account section appears whenever the
 * deploy has a login session (accounts OR OIDC/SSO — i.e. a `login_url`
 * exists), so an SSO user can see who they're signed in as and sign out; it's
 * absent in header single-user mode. Members and Policies retain their admin gates.
 */
export function settingsNavGroups(
  hasAuthSession: boolean,
  isDesktop: boolean,
  isAdmin = false,
  isSingleUser = false,
  integrationsEnabled = false,
  customAgentsEnabled = false,
  mcpEnabled = false,
): SettingsNavGroup[] {
  const harnesses: SettingsNavItem = {
    id: "harnesses",
    label: "Harnesses",
    icon: VectorSquareIcon,
  };
  const general: SettingsNavItem[] = [
    { id: "general", label: "General", icon: SettingsIcon },
    { id: "appearance", label: "Appearance", icon: PaletteIcon },
    { id: "git", label: "Git", icon: GitBranchIcon },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: KeyboardIcon, hideOnMobile: true },
    { id: "import", label: "Import sessions", icon: DownloadIcon },
  ];
  if (!customAgentsEnabled) general.splice(2, 0, harnesses);
  // Provider credentials and MCP accounts have separate settings pages.
  if (integrationsEnabled) {
    general.splice(2, 0, {
      id: "integrations",
      label: "Sandbox Integrations",
      icon: BlocksIcon,
    });
  }
  if (mcpEnabled) {
    general.splice(2, 0, { id: "mcp", label: "MCP", icon: PlugIcon });
  }
  const groups: SettingsNavGroup[] = [{ title: "General", items: general }];
  if (customAgentsEnabled) {
    groups.push({
      title: "Customize",
      items: [harnesses, { id: "custom-agents", label: "Custom agents", icon: BotIcon }],
    });
  }
  // Keep shell-specific settings directly after the cross-platform preferences.
  if (isDesktop) {
    groups.push({
      title: "Desktop",
      items: [
        { id: "cli", label: "Local CLI", icon: TerminalIcon },
        { id: "updates", label: "Updates", icon: DownloadIcon },
      ],
    });
  }
  const adminItems: SettingsNavItem[] = [];
  if (hasAuthSession) adminItems.push({ id: "account", label: "Account", icon: UserCogIcon });
  if (isAdmin) {
    // Members (manage other accounts) and Sharing (grant sessions to other
    // users) have no meaning in single-user mode — there are no other users —
    // so drop both from the nav there. Policies stays: global policies apply
    // to a solo user's own sessions too.
    if (!isSingleUser) adminItems.push({ id: "members", label: "Members", icon: UsersIcon });
    adminItems.push({ id: "policies", label: "Policies", icon: ShieldCheckIcon });
    if (!isSingleUser) adminItems.push({ id: "sharing", label: "Sharing", icon: Share2Icon });
  }
  if (adminItems.length) groups.push({ title: "Admin", items: adminItems });
  groups.push({
    title: "Archived",
    items: [{ id: "archived", label: "Archived sessions", icon: ArchiveIcon }],
  });
  return groups;
}

/**
 * Parse the active route into a settings descriptor. `inSettings` gates the
 * sidebar body swap; `section` drives the content. Bare `/settings` (no
 * section segment) and unknown sections default to General. Basename-agnostic
 * — matches the `settings` segment wherever it lands, same approach as the
 * sidebar's top-level nav detection. `harness` is the third segment of
 * /settings/harnesses/<harness> (the harness details page), when present.
 */
export function useSettingsRoute(): {
  inSettings: boolean;
  section: SettingsSectionId;
  harness?: string;
  agentId?: string;
} {
  const info = useServerInfo();
  const defaultSection: SettingsSectionId = "general";

  const segments = useLocation().pathname.split("/").filter(Boolean);
  const idx = segments.lastIndexOf("settings");
  if (idx === -1) return { inSettings: false, section: defaultSection };
  const next = segments[idx + 1];
  // Members / Policies / Sharing are admin sections valid in ANY multi-user
  // mode (accounts AND OIDC). They're gated in the nav on `is_admin` and the
  // pages self-gate + the server 403s, so no accounts-mode carve-out here.
  // Members and Sharing are the exception: single-user mode has no other
  // users, so a direct hit to either falls back to the default section.
  const singleUser = isSingleUserMode(info);
  const isValidSection =
    (SECTION_IDS as readonly string[]).includes(next) &&
    !(singleUser && (next === "members" || next === "sharing")) &&
    !(next === "custom-agents" && !customAgentsSettingsEnabled(info));
  const section = isValidSection ? (next as SettingsSectionId) : defaultSection;
  const harness = section === "harnesses" ? segments[idx + 2] : undefined;
  if (section === "custom-agents" && segments[idx + 2]) {
    try {
      return { inSettings: true, section, agentId: decodeURIComponent(segments[idx + 2]) };
    } catch {
      // Malformed escapes in a bookmarked URL should not crash Settings.
      return { inSettings: true, section };
    }
  }
  return harness ? { inSettings: true, section, harness } : { inSettings: true, section };
}

/** Use the same capabilities and identity gates for both navigation surfaces. */
function useSettingsNavGroups(): SettingsNavGroup[] {
  const info = useServerInfo();
  // Account section shows whenever there's a login session (accounts OR OIDC).
  const hasAuthSession = info !== "loading" && info.login_url !== null;
  // Admin gating for the Members / Policies sub-categories. Sourced from
  // `/v1/me` (mode-agnostic) so the group appears for admins under OIDC too,
  // not just accounts deploys.
  const isAdmin = useIsAdmin();
  const integrationsEnabled =
    info !== "loading" && (info.enabled_connections ?? []).some((provider) => provider !== "mcp");
  const mcpEnabled = info !== "loading" && (info.enabled_connections ?? []).includes("mcp");
  return settingsNavGroups(
    hasAuthSession,
    isElectronShell(),
    isAdmin,
    isSingleUserMode(info),
    integrationsEnabled,
    customAgentsSettingsEnabled(info),
    mcpEnabled,
  );
}

export function SettingsDirectory({
  onNavClick,
  directoryRef,
}: {
  onNavClick: React.MouseEventHandler<HTMLAnchorElement>;
  directoryRef?: React.Ref<HTMLElement>;
}) {
  const { section } = useSettingsRoute();
  const groups = useSettingsNavGroups();
  const serverPicker = supportsNativeServerPicker();
  if (serverPicker && !groups.some((group) => group.title === "Admin")) {
    groups.splice(
      groups.findIndex((group) => group.title === "Archived"),
      0,
      { title: "Admin", items: [] },
    );
  }
  return (
    <nav
      ref={directoryRef}
      tabIndex={-1}
      aria-label="Settings sections"
      className="settings-directory group/sidebar flex flex-col gap-4 p-3"
      data-input="mouse"
    >
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h2 className="flex h-7 items-center px-2 text-sm font-normal text-muted-foreground">
            {group.title}
          </h2>
          <div className="mt-1 density-list flex flex-col">
            {group.items.map(({ id, label, icon: Icon, hideOnMobile }) => (
              <SidebarNavAction
                key={id}
                active={id === section}
                className={cn(hideOnMobile && "max-md:hidden")}
              >
                <Link
                  to={`/settings/${id}`}
                  onClick={onNavClick}
                  aria-current={section === id ? "page" : undefined}
                  componentId={`settings.nav.${id}`}
                  data-testid={`settings-nav-${id}`}
                >
                  <Icon aria-hidden className="ui-icon text-muted-foreground" />
                  {label}
                </Link>
              </SidebarNavAction>
            ))}
            {group.title === "Admin" && serverPicker && <SidebarServerPicker />}
          </div>
        </section>
      ))}
    </nav>
  );
}
