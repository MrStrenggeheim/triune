// Modified for Triune.
// Shared model + sidebar body for the Settings surface.
//
// Entering /settings doesn't swap out the conversations sidebar card — the
// SAME card just renders this nav in place of the conversation list, while
// the main area shows the selected section's content (SettingsPage). Section
// selection is URL-driven (/settings/<section>) so the nav (in the sidebar)
// and the content (in the outlet) stay in sync without shared state.

import { useEffect } from "react";
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
import { Link, useLocation, useNavigate } from "@/lib/routing";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { customAgentsSettingsEnabled, isSingleUserMode } from "@/lib/capabilities";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { isElectronShell } from "@/lib/nativeBridge";
import { cn } from "@/lib/utils";
import { SidebarSettingsFooter } from "./SidebarHeaderActions";
import { SIDEBAR_ROW } from "./sidebarStyles";

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

// Last location the user was on before entering /settings — path + search so
// the conversation (and its ?file= etc.) is preserved. The Back row
// returns here instead of the home page. Module-scoped: the sidebar stays
// mounted across the settings transition, so the value captured on the last
// non-settings render survives into settings.
let settingsReturnPath = "/";

/**
 * Record the current location as the settings return target whenever the user
 * is NOT in settings. Call from a component that stays mounted across the
 * transition into /settings (the Sidebar) so the last conversation is captured
 * before the swap.
 */
export function useTrackSettingsReturn(): void {
  const { pathname, search } = useLocation();
  const { inSettings } = useSettingsRoute();
  useEffect(() => {
    if (!inSettings) settingsReturnPath = `${pathname}${search}`;
  }, [inSettings, pathname, search]);
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

/** Mobile navigation remains in the content header even with the drawer closed. */
export function SettingsSectionChooser() {
  const groups = useSettingsNavGroups();
  const { section } = useSettingsRoute();
  const navigate = useNavigate();
  return (
    <Select value={section} onValueChange={(value) => navigate(`/settings/${value}`)}>
      <SelectTrigger aria-label="Settings section" className="h-11 w-full">
        <SelectValue placeholder="Choose a section" />
      </SelectTrigger>
      <SelectContent position="popper">
        {groups.map((group) => (
          <SelectGroup key={group.title}>
            <SelectLabel>{group.title}</SelectLabel>
            {group.items
              .filter((item) => !item.hideOnMobile)
              .map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  <item.icon className="size-4" aria-hidden />
                  {item.label}
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Settings sections in the shell's existing sidebar. */
export function SettingsSidebarBody({
  onNavClick,
}: {
  onNavClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { section } = useSettingsRoute();
  const groups = useSettingsNavGroups();

  return (
    <>
      <nav className="settings-sidebar-header flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
        {groups.map((group) => (
          <div key={group.title} className="flex flex-col">
            <h2 className="flex h-7 items-center px-2 text-sm font-normal text-muted-foreground">
              {group.title}
            </h2>
            <div className="mt-1 flex flex-col gap-px">
              {group.items.map((item) => {
                const Icon = item.icon;
                const selected = section === item.id;
                return (
                  <Button
                    key={item.id}
                    asChild
                    variant="ghost"
                    className={cn(
                      SIDEBAR_ROW,
                      "w-full justify-start border-0 font-normal",
                      selected &&
                        "bg-[var(--sidebar-active)] text-[var(--sidebar-active-foreground)] hover:bg-[var(--sidebar-active)] hover:text-[var(--sidebar-active-foreground)] dark:hover:bg-[var(--sidebar-active)] dark:hover:text-[var(--sidebar-active-foreground)]",
                      item.hideOnMobile && "max-md:hidden",
                    )}
                  >
                    <Link
                      to={`/settings/${item.id}`}
                      onClick={onNavClick}
                      data-testid={`settings-nav-${item.id}`}
                      componentId={`settings.nav.${item.id}`}
                      aria-current={selected ? "page" : undefined}
                    >
                      <Icon
                        className={cn(
                          "ui-icon",
                          selected
                            ? "text-[var(--sidebar-active-foreground)]"
                            : "text-muted-foreground",
                        )}
                      />
                      {item.label}
                    </Link>
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <SidebarSettingsFooter returnPath={settingsReturnPath} />
    </>
  );
}
