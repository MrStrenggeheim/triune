# Mobile workspace navigation

On mobile, the header orders the left sidebar toggle, title, chat actions, Notifications and right sidebar toggle; opening either sidebar leaves its close toggle at the same viewport position with the narrow icon segment filled.
Workspace drawers and the phone's full-screen file viewer share horizontally scrolling tabs, reuse existing panel contents and lifecycles, and reopen the last selected available workspace page in the current session.

Default chat routes now use the application Open menu and docked views.
Follow [Unified workspace](unified-workspace.md) for those entry points; older right-rail recipes below describe retained compatibility surfaces.

## Sub-features

- `panel-menu`: the compact + menu lists tool panels and creates a manual shell when the selected workspace supports terminals.
- `fixed-control-rows`: compatibility drawer headers stay 48px; the docked application bar follows 48px Comfortable/36px Compact density, with horizontal tabs and independently scrolling bodies.
- `native-safe-paint`: native top clearance, browser theme-color and standalone status paint follow the resolved application bar; the shell reserves safe insets once and composer gutters follow density.
- `application-open`: the top-bar Open button restores its 28px face with transparent hit expansion into free row space, independently of the tab-strip plus.

- `overlay-order`: opening the left sidebar preserves Workspace underneath it; revealing Workspace dismisses the left sidebar and restores its selected page.

- `compact-controls`: shared header icons retain their 24px surface and separate touch targets; the docked top-bar Open button uses its explicit 28px face and row-bounded target.
- `stable-toggles`: left and right outline-panel controls retain their viewport positions and fill the respective narrow segment while open.
- `header-split`: separate the workspace panel icon from the chat-actions kebab; workspace navigation remains reachable when no chat actions are available.
- `tabs`: scroll horizontally through Files, Changes, Search, Shells, Agents, Pull Requests, Side chats and Logs when available for the session.
- `capabilities`: omit unavailable pages and omit the workspace button when no pages are available, while a session is pending or on the landing composer.
- `selection`: close and reopen the last selected page in the current session; fall back to the first available page if that page disappears or the session changes.
- `focus`: selecting a tab opens its page, updates selection and brings the active tab into view; keyboard navigation follows the available tabs.
- `input-mapping`: dock tabs activate on the first touch tap; touch hold keeps the explicit context menu and drag continuation, while fine-pointer hover actions require current mouse or pen intent and keyboard actions retain their focus ring.
- `files`: open Files or Changes, select a file and retain the shared workspace tabs in the phone's full-screen viewer.
- `dirty-file`: switching workspace tabs from the file viewer uses the existing unsaved-edit confirmation before leaving the file.
- `empty-shells`: expose Shells and New shell for shell-capable sessions before any user shells exist.
- `lifecycle`: reuse existing loading, empty, error, permissions, search, terminal, agent, PR, side-chat and log behavior when changing pages.

## How to get to it (user POV)

- Docked mobile application bar: tap the plus labeled **Open view** for the shared view menu; use Appearance to switch Comfortable/Compact density.
- Mobile conversation header: tap the rightmost **Open workspace** panel icon after Notifications to open the remembered available workspace page.
- Mobile conversation header: open **Conversation actions** for chat management such as Rename or Archive; workspace pages are reached through the separate panel icon.
- Workspace drawers: swipe the tab strip horizontally and select **Files**, **Changes**, **Search**, **Shells**, **Agents**, **Pull Requests**, **Side chats** or **Logs** as available; close the drawer and tap **Open workspace** to reopen the selected page.
- Files or Changes drawer: select a file to open the phone's full-screen file viewer, then use the same workspace tabs to reach another page.
- Shells drawer: select **Shells**, then **New shell**, including when the session has no user shells yet.
- Files search actions: open content search from the Files toolbar or a folder's search action and continue navigating with the shared workspace tabs.

## Driving it with the repro environment

Preconditions: use the isolated [verification environment](skills/verify-omnigent/SKILL.md) and follow the [map's baseline and driving conventions](README.md#baseline-preconditions).
Use a ready session with filesystem access for Files, Changes, Search and Pull Requests, a shell-capable session for the empty-shell case, and suitable session capabilities for Side chats.
Agents requires a resolved root session; Logs requires debug mode.
Use widths of 320px, 390px with dark appearance and 700px for the header and drawer journey, below the 768px desktop breakpoint.
Seed a readable text file for the viewer journey; an empty Changes page in a non-Git workspace does not establish that Files is empty.

- Iteration6 candidate compact shelves, top-bar Open appearance/hit separation and synthetic native top paint: `tests/browser_ui/chat/test_iteration6.py::test_queue_plan_popup_and_synthetic_safe_top_follow_density`.
- After parent freeze/build, switch density with a draft, queue and attention shelf: spacing shrinks, shelf controls remain reachable and the draft persists.
- Open the top-bar menu from its transparent edge; expect the same menu, a 28px face and no activation of adjacent Search or Notifications.
- Check native top paint against the application bar and bottom paint against content; main/side-chat gutters are 8px Comfortable or 4px Compact with one shell inset.
- Browser theme metadata follows resolved appbar paint across mode/accent changes: `web/src/components/theme/ThemeProvider.test.tsx`; standalone shim paint still needs physical Home Screen acceptance.
- Header split, drawer tabs and reopening: `tests/e2e_ui/mobile/test_mobile_workflow.py::test_mobile_workspace_keeps_chat_actions_separate` covers 320px, 390px dark and 700px widths.
  Confirm the separate header buttons, Rename in the chat menu, absence of workspace entries from that menu, Files → Changes → Search → Agents navigation, close/reopen on Agents, and navigation to Pull Requests and back to Files.
- Files drawer to full-screen file viewer: `tests/e2e_ui/mobile/test_mobile_workflow.py::test_mobile_files_drawer_opens_seeded_file` opens the workspace and the seeded file, then checks its name and real content, then switches to Agents and back to Files.
- Shells drawer before shell creation: `tests/e2e_ui/mobile/test_mobile_workflow.py::test_mobile_shells_drawer_exposes_new_shell_before_shells_exist` checks that Shells and New shell are reachable with zero user shells.
- Header availability and chat-action separation: `web/src/shell/ChatHeader.test.tsx` covers owner and nonowner menus, workspace access without chat actions, unavailable controls and pending sessions.
- Shared tab selection, focus, capability changes, session changes and deferred navigation confirmation: `web/src/shell/MobileWorkspace.test.tsx`.
- Dock tab first-tap activation, held menus, drag continuation, pointer-intent actions and guarded close behavior: `web/src/workbench/DockWorkspace.test.tsx`.
- Existing drawer routing, page availability and shell entry behavior: `web/src/shell/AppShell.test.tsx`.

For full-screen viewer tab navigation, open the seeded file, confirm the same workspace tabs remain visible, and switch to Changes or Search.
Reopen the file, edit without saving, and select another workspace tab.
Confirm that cancelling the unsaved-edit prompt keeps the file and tab selected, then repeat and confirm leaving to reach the requested page.
This checks the viewer's existing unsaved-file guard; the seeded-file E2E alone does not prove unsaved-edit protection.

For Side chats and Logs, enable their prerequisites, open each through the tab strip and confirm that its existing content appears and closing/reopening returns to it.
For Files search actions, open search from the toolbar and a folder action, verify the selected search page, then switch to another workspace tab.
At 320px, swipe to the final available tab and back, checking that tabs remain reachable without widening the page.
Keep these manual results separate from the automated journeys above and record unmet capability prerequisites.

## Gotchas

- Iteration6 is source only relative to installed `0.20.0-3c12d054fd99`; the parent owns compiled verification and activation.
- Synthetic native insets and Chromium touch injection do not prove physical-device, keyboard, browser-chrome or installed-PWA behavior.
- Mobile Open deliberately uses a 32px-wide target and header height minus 4px; it does not claim a 44px-wide target.
- This implements mobile navigation within the selected session; no global host, files or shell scope is implemented.
- Desktop navigation remains unchanged; phone-width browser checks do not establish desktop behavior.
- The last-page memory applies to closing and reopening within the current session, not durable restoration across reloads or a history of selections across sessions.
- Page availability follows existing capabilities and permissions; Search can be disabled, Side chats depends on harness support and Logs appears only in debug mode.
- The agent's own terminal and user shells retain their existing distinction and lifecycle; the Shells tab does not create a host-owned terminal service.
- Shared navigation reuses existing panel contents and lifecycles; it does not redefine loading, errors, permissions or persistence for each tool.
- Switching away from an unsaved file must pass the existing dirty-file guard; tab navigation must not silently discard edits.
- Some older test names or docstrings still mention kebab workspace entries; follow the current separate Open workspace button and shared tabs.
- Responsive browser coverage at 320px, 390px dark and 700px is not physical native-device verification; no physical iOS or Android device verification is recorded yet.
