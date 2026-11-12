# Unified workspace

Conversation and tool views share resizable, dockable panes while keeping their own resources, drafts and process lifecycles.

## Sub-features

- `panes`: split, resize, move and reorder views without remounting their editors or terminal attachments.
- `layouts`: each chat automatically owns its arrangement; explicit side-open/drop adds a chat to the current arrangement, with global view pins preserved.
- `resources`: each Explorer, Search, Changes and Preview owns its machine, folder and presentation state.
- `hierarchy`: durable branches preserve their captured fork boundary independently from delegated-agent parentage.
- `communication`: structured attribution distinguishes agent messages from human input and separates acceptance from consumption.
- `references`: whole chats, completed answers, selected messages and quotes enter drafts with stable source snapshots.
- `activity`: retained shell history and the dedicated Activity view expose actual activity; the composer dock is disabled.
- `navigation`: global commands, contextual find, explicit conversation sources and mobile view switching retain existing workflows.
- `appearance`: shared content surfaces, primary bottom tab strips, consistent switches and list density follow `design-system/triune/MASTER.md`.
- `migration`: existing conversation, file and shell references remain accessible without starting or stopping resources.

## How to get to it (user POV)

- Use + Open in the application bar to add Explorer, Changes, Search, a manual terminal, Agent CLI, Activity or Automations.
- Drag a tab to a pane edge to split; use its own close button to close it, use the tab pin before its close control to keep a view across chats.
- Click a chat to restore its layout; choose Open to side or drag a sidebar chat into a tab group or split edge to add it to the current layout.
- The app bar has no Layout control; a new chat starts in its own arrangement.
- Expand conversations with children to revisit subchats; use the trailing count/chevron to expand subchats; draft, unread and running markers remain on the right, beside hover actions.
- Use New subchat in the composer Add menu or `/side` to open a durable child with an unsent draft.
- Type `@` in a composer, or select text and choose Send to…, to inspect and insert captured context.
- Use the application search field or Ctrl/Cmd+K for commands; it opens below the trigger without a blurred backdrop.
- The sidebar Search entry is hidden; contextual Ctrl/Cmd+F still searches the last interacted region.
- Open Activity and choose a Host to reattach independent shells or inspect retained output; choose a Chat for its agents, messages and shell use.
- Use the grouped Host/Chat source picker in Activity or a Preview's Comments control to choose its owner explicitly.
- Use the combined workspace selector in the composer or resource-view toolbar; Host and Path are both directly reachable in its modal.
- Use Up before the Explorer workspace path to make its parent folder the root.
- Opening Settings temporarily reveals desktop navigation; its mobile section chooser stays reachable when navigation is closed.
- Open Settings → Appearance to change the accent or list density.

## Driving it with the repro environment

Preconditions: follow the [verification skill](skills/verify-omnigent/SKILL.md), build the checkout and use an isolated environment or the sealed browser-contract lane.

- Compact composer, mobile tabs, density-aware headers/sidebar padding and single safe-area inset: `tests/browser_ui/chat/test_workspace_selection_design.py::test_mobile_composer_keeps_tabs_and_follows_appearance_density`.
- Approved palette, root confirmation, Settings and Activity sources: `tests/browser_ui/chat/test_workspace_selection_design.py`.
- Combined picker and controlled chat switching: `web/src/shell/WorkspaceSelectionDialog.test.tsx` and `web/src/components/composer/WorkspaceSwitchControl.test.tsx`.
- Host/Chat Activity and temporary Settings navigation: `web/src/workbench/ActivityView.test.tsx` and `web/src/hooks/useSettingsNavigationVisibility.test.tsx`.
- Integrated desktop/mobile shell, drafts, layout controls and commands: `tests/browser_ui/chat/test_unified_workspace.py`.
- Pane movement, retained editor nodes, resizing, scope changes and A/B/A pins: `web/src/workbench/DockWorkspace.test.tsx` and `web/src/workbench/dockLayout.test.ts`.
- Independent file targets and captured writes: `web/src/workbench/ResourceView.test.tsx`.
- Durable composer branching and keyboard resource reuse: `web/src/workbench/durableSubchat.test.ts` and `web/src/workbench/resourceShortcuts.test.ts`.
- Scoped chat actions, initial sends and draft migration: `web/src/workbench/ScopedChatStore.test.tsx`, `web/src/workbench/useScopedInitialPrompt.test.tsx` and `web/src/workbench/conversationDraft.test.ts`.
- Reattachment, explicit stop and retained terminal output: `web/src/workbench/TerminalResourceView.test.tsx` and `web/src/workbench/TerminalInventoryView.test.tsx`.
- Peer presentation and activity: `web/src/components/blocks/PeerMessage.test.tsx`, `web/src/hooks/usePeerMessages.test.tsx` and `web/src/components/composer/ConversationActivityDock.test.tsx`.
- References, quote destinations and authorized snapshots: `web/src/components/composer/ContextReferences.test.tsx` and `tests/stores/test_context_references.py`.
- Hierarchy and native recovery: `tests/stores/test_conversation_store.py`, `tests/server/integration/test_sessions_fork.py` and `tests/runner/test_suppress_recovery_turn.py`.
- Delivery authorization and deduplication: `tests/server/integration/test_session_orchestration.py`.
- Appearance and migration: `web/src/lib/listDensityPreferences.test.tsx`, `web/src/lib/themePalette.test.ts` and `web/src/workbench/legacyLayout.test.ts`.
- Manually open two chats, an Explorer and a Markdown Preview; type distinct drafts, move the tabs, reload and verify every resource and draft remains attached to its original owner.

## Gotchas

- Closing a view preserves its conversation, shell or schedule; explicit Stop/Delete retains its existing permission and confirmation checks.
- Workspace headers are 48px Comfortable or 36px Compact; sidebar padding follows the same density setting.
- Desktop tab/container headers and view headers remain separate even with one tab; mobile reuses scrolling tabs across all panes.
- Type icons live in desktop tabs, and close controls have accessible names without tooltips.
- Narrow composer workspace labels collapse while the full location stays accessible; the mobile bottom safe area is reserved once.
- Neutral hairlines separate equal-colored viewports; distinct surface colors provide their own boundary.
- App bar is medium-light accent, sidebar pale accent, tabs/view headers/content neutral; active tabs have a primary bottom strip and primary controls use white foregrounds.
- Tab/disclosure hover feedback changes instantly, and selected entries retain their selected appearance.
- Shell inventory is integrated into Activity; legacy saved inventory views restore there without stopping their processes.
- Chat workspace changes retain execution confirmation/recovery; browsing-view root changes only retarget that view.
- Conversation hover cards and per-row loading/empty-child labels are removed; hierarchy metadata preloads without transcript downloads.
- Global pins retain their exact pane size and position across chats; resizing updates the global reservation, while other layouts fill the remaining regions.
- Shared-chat file access can retain its session-authorized route; a chat grant does not grant general host access.
- Unknown delivery or process state is not successful consumption or a confirmed exit.
- Legacy branches with missing provenance stay unknown; unsupported native recovery fails visibly without deleting readable history.
- Browser contracts and scripted providers do not prove live-provider behavior or physical mobile-wrapper support.
- Canvas and saved conversation grids retain their existing routes; they are not silently converted into new layouts.
- Their legacy shell unit coverage remains in `web/src/shell/AppShell.test.tsx`; default docked routes use the browser journeys above.

### Approved iteration acceptance

- Select chat text: Reply has one icon; Ask subchat… creates a durable child with an unsent quote; Send to… preserves the chosen chat's draft.
- In an existing or new composer, microphone follows Add; control labels share typography and foreground, with effort secondary.
- The workspace control reads computer icon and Host:/path; narrow composers still collapse its text.
- Open an inline attachment into a preview tab, download its original, reload, and Reveal in Explorer; captured content and source workspace remain independent of current chat selection.
- Change Appearance density on desktop and mobile; headers and sidebar spacing update consistently, and scrollbar treatment remains slim.
- Views use the content surface and primary active-tab bottom strip; colored surface boundaries have no redundant border.
- The mobile bottom gesture area blends into the content surface without a pane-bottom divider.
- Chat/Terminal uses the existing segmented switch in the chat header, immediately before the three-dot actions.

Verification: `tests/browser_ui/chat/test_workspace_iteration.py`, the existing workspace selection/design and unified workspace journeys, and the owning component suites.
Layout miniatures and Inbox consolidation remain deferred.

### Current cycle controls

- Host/path follows approved B: computer icon, secondary Host, middle dot, primary path and chevron.
- Add host is directly reachable in every workspace dialog; it reuses server-specific instructions without losing the path draft.
- Inline chips open beside their originating chat; right-click or touch overflow exposes tab/modal/reveal/copy/download destinations.
- Rendered previews retain the existing large modal/image lightbox with supported zoom and pan.
- A pinned tab always has a filled pin; pinning and unpinning do not move or narrow its pane.
- Nested pinned reservations can leave empty, usable drop regions when another chat has fewer panes.
- Tab-bar drops show a primary insertion line; edge drops preview their final half-pane geometry using the shared file-drop surface.
- Right-click a tab for view controls; tab overflow has a right fade and no visible scrollbar.
- Sidebar hierarchy has shallow guide lines, readable disclosure hover and recursive descendant counts after complete metadata loads.
- Shared overflow surfaces use transcript-style overlay thumbs; fitting content, composers and tab bars have no visible scrollbar.
- Appearance density choices include shared preview cards; buttons do not shift vertically when pressed.
- Search control and popup center on the whole application, independently of adjacent actions.

Acceptance and evidence: "'`tests/browser_ui/chat/test_workspace_cycle.py`, `test_workspace_iteration.py` and `test_workspace_selection_design.py` in the same folder.
Use desktop/mobile and both color modes; verify drafts, original file bytes and per-chat arrangements survive reload.
'"
