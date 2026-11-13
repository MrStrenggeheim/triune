# Unified workspace

Conversation and tool views share resizable, dockable panes while keeping their own resources, drafts and process lifecycles.

## Sub-features

- `panes`: split, resize, move and reorder views without remounting their editors or terminal attachments.
- `layouts`: each chat automatically owns its arrangement; explicit side-open/drop adds a chat to the current arrangement, with global view pins preserved.
- `resources`: each Explorer, Search, Changes and Preview owns its machine, folder and presentation state.
- `hierarchy`: durable branches preserve their captured fork boundary independently from delegated-agent parentage.
- `communication`: structured attribution distinguishes agent messages from human input and separates acceptance from consumption.
- `references`: whole chats, completed answers, selected messages and quotes enter drafts with stable source snapshots.
- `activity`: Orchestration presents agents and shells; the original conditional composer shelf exposes questions, approvals and task progress, while the custom activity dock stays disabled.
- `navigation`: global commands, contextual find, explicit conversation sources and mobile view switching retain existing workflows.
- `appearance`: shared content surfaces, primary bottom tab strips, consistent switches and list density follow `design-system/triune/MASTER.md`.
- `migration`: existing conversation, file and shell references remain accessible without starting or stopping resources.

## How to get to it (user POV)

- Use + Open beside desktop application Search, or the subtle plus after the last tab, to add Explorer, Changes, Search, a manual terminal, Agent CLI, Orchestration or Automations.
- Drag a tab to split; use its own close control, or hover/focus its type icon to pin it across chats.
- Click a chat to restore its layout; choose Open to side or drag a sidebar chat into a tab group or split edge to add it to the current layout.
- The app bar has no Layout control; a new chat starts in its own arrangement.
- Expand conversations with children to revisit subchats; use the trailing count/chevron to expand subchats; draft, unread and running markers remain on the right, beside hover actions.
- Use New subchat in the composer Add menu or `/side` to open a durable child with an unsent draft.
- Type `@` in a composer, or select text and choose Send to…, to inspect and insert captured context.
- Use the application search field or Ctrl/Cmd+K for commands; it opens below the trigger without a blurred backdrop.
- The sidebar Search entry is hidden; contextual Ctrl/Cmd+F still searches the last interacted region.
- Open Orchestration and choose Host/workspace for independent shells or Chat for its agents and shell use; location starts from the captured source.
- Use the grouped Host/Chat source picker in Orchestration or a Preview's Comments control to choose its owner explicitly.
- Use the combined workspace selector in the composer or resource-view toolbar; Host and Path are both directly reachable in its modal.
- Use Up before the Explorer workspace path to make its parent folder the root.
- Opening Settings temporarily reveals desktop navigation; its mobile section chooser stays reachable when navigation is closed.
- Open Settings → Appearance to change the accent or list density.

## Driving it with the repro environment

Preconditions: follow the [verification skill](skills/verify-omnigent/SKILL.md), build the checkout and use an isolated environment or the sealed browser-contract lane.

- Compact composer, mobile tabs, density-aware headers/sidebar padding and single safe-area inset: `tests/browser_ui/chat/test_workspace_selection_design.py::test_mobile_composer_keeps_tabs_and_follows_appearance_density`.
- Approved palette, root confirmation, Settings and Orchestration sources: `tests/browser_ui/chat/test_workspace_selection_design.py`.
- Combined picker and controlled chat switching: `web/src/shell/WorkspaceSelectionDialog.test.tsx` and `web/src/components/composer/WorkspaceSwitchControl.test.tsx`.
- Host/Chat Orchestration and temporary Settings navigation: `web/src/workbench/ActivityView.test.tsx` and `web/src/hooks/useSettingsNavigationVisibility.test.tsx`.
- Integrated desktop/mobile shell, drafts, layout controls and commands: `tests/browser_ui/chat/test_unified_workspace.py`.
- Pane movement, retained editor nodes, resizing, scope changes and A/B/A pins: `web/src/workbench/DockWorkspace.test.tsx` and `web/src/workbench/dockLayout.test.ts`.
- Fifty saved layouts, bounded mounts and protected editor Undo: `tests/browser_ui/chat/test_triune_next_iteration.py::test_fifty_layouts_retire_while_preserving_draft_and_editor_undo` and `web/src/workbench/DockWorkspace.retirement.test.tsx`.
- Retained dirty editors switch layouts without discard prompts, while explicit file close keeps its guard: `tests/browser_ui/chat/test_unified_workspace.py::test_retained_dirty_navigation_preserves_editor_and_close_guard`.
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
- Shell inventory is integrated into Orchestration; legacy saved inventory views restore there without stopping their processes.
- Chat workspace changes retain execution confirmation/recovery; browsing-view root changes only retarget that view.
- Conversation hover cards and per-row loading/empty-child labels are removed; hierarchy metadata preloads without transcript downloads.
- Global pins retain their exact pane size and position across chats; resizing updates the global reservation, while other layouts fill the remaining regions.
- Shared split limits allow 20–80% resizing, including nested panes; existing 25–75% saved layouts remain valid.
- Shared-chat file access can retain its session-authorized route; a chat grant does not grant general host access.
- Unknown delivery or process state is not successful consumption or a confirmed exit.
- Legacy branches with missing provenance stay unknown; unsupported native recovery fails visibly without deleting readable history.
- Browser contracts and scripted providers do not prove live-provider behavior or physical mobile-wrapper support.
- Canvas and saved conversation grids retain their existing routes; they are not silently converted into new layouts.
- Their legacy shell unit coverage remains in `web/src/shell/AppShell.test.tsx`; default docked routes use the browser journeys above.

### Approved iteration acceptance

- Select chat text: Reply has one icon; Ask subchat… creates a durable child with an unsent quote; Send to… preserves the chosen chat's draft.
- In an existing or new composer, microphone follows Add; control labels share typography and foreground, with effort secondary.
- The workspace control reads computer icon and Host · /path; narrow composers still collapse its text.
- Open a live workspace-file chip into the File Editor, edit/comment normally, and download its captured original from the three-dot menu.
- Open rendered previews and stored attachments in the existing preview/lightbox; their bytes remain independent of the current chat and temporary source.
- Change Appearance density on desktop and mobile; headers and sidebar spacing update consistently, and scrollbar treatment remains slim.
- Views use the content surface and primary active-tab bottom strip; colored surface boundaries have no redundant border.
- The mobile bottom gesture area blends into the content surface without a pane-bottom divider.
- Chat/Terminal uses the existing segmented switch in the chat header, immediately before the three-dot actions.

Verification: `tests/browser_ui/chat/test_workspace_iteration.py`, the existing workspace selection/design and unified workspace journeys, and the owning component suites.
Layout miniatures and Inbox consolidation remain deferred.

### Current cycle controls

- Host/path follows approved B: computer icon, secondary Host, middle dot, primary path and chevron.
- Add host is directly reachable in every workspace dialog; it reuses server-specific instructions without losing the path draft.
- Live-file chips use the File Editor and the Appearance file-opening preference; right-click or touch overflow exposes explicit destinations and file actions.
- Rendered previews retain the existing large modal/image lightbox with supported zoom and pan.
- A pinned tab has a filled type icon at rest and filled pin on hover/focus; pinning preserves geometry.
- Nested pinned reservations can leave empty, usable drop regions when another chat has fewer panes.
- Tab-bar drops show a primary insertion line; edge drops preview their final half-pane geometry using the shared file-drop surface.
- Right-click a tab for view controls; tab overflow has a right fade and no visible scrollbar.
- Sidebar hierarchy has shallow guide lines, readable disclosure hover and recursive descendant counts after complete metadata loads.
- Shared overflow surfaces use transcript-style overlay thumbs; fitting content, composers and tab bars have no visible scrollbar.
- Appearance density choices include shared preview cards; buttons do not shift vertically when pressed.
- Search control and popup center on the whole application, independently of adjacent actions.
- On desktop, + Open follows centered Search with an 8px gap; phones retain their existing plus, bell and Settings arrangement.

Acceptance and evidence: `tests/browser_ui/chat/test_workspace_cycle.py`, `test_workspace_iteration.py` and `test_workspace_selection_design.py` in the same folder.
Use desktop/mobile and both color modes; verify drafts, original file bytes and per-chat arrangements survive reload.

### File editing and stable navigation

- Appearance → Open files from chat selects Same pane, Beside, Always split or Reuse pane; Beside reuses an existing neighboring pane before splitting.
- Authorized reference metadata identifies files and folders without downloading contents; source workspace/generation and chat grants remain enforced.
- Opening a live chip captures its original before editing; passive classification neither captures bytes nor grants new filesystem access.
- The File Editor header has one copyable Host/path, Comments, Diff and a three-dot menu; choose the comments chat inside the comments sidebar.
- Notifications follow Comfortable/Compact density, preserve Undo, offer Show read and name archived chats.
- Hidden Explorer/transcript geometry is retained across chat changes; visible remeasurement restores real dimensions without zero-height cache writes.
- Sidebar hierarchy omits a chat from Sessions when its loaded ancestor already presents it under a project, while retaining explicit project/pin placement and unknown orphans.
- Modified Git entries use the inherited amber indicator; other status precedence is unchanged.

Verification: `tests/browser_ui/chat/test_triune_next_iteration.py`, `test_workspace_iteration.py`, `web/src/workbench/filePlacement.test.ts`, `web/src/components/ChatAttachment.test.tsx`, `web/src/components/chat/QuoteDestinationMenu.test.tsx`, `web/src/shell/useScrollRestore.geometry.test.ts` and the owning notification, sidebar, picker and transcript suites.
Backend boundaries: `tests/server/routes/test_chat_attachments.py` and `tests/stores/test_context_references.py`.
Hidden-measurement and scrollbar tests count avoided work; they do not establish frame-rate improvements or physical-device behavior.

### Retained-view performance

- Switching chats and adding file tabs keep unrelated retained resources behind stable render and context boundaries.
- Old hidden layouts retire automatically while saved membership remains; recent views stay warm briefly and unsafe local models remain resident.
- Inactive file, comparison, expanded-directory and Activity queries pause; revealing a view restores observation using its existing keys and cached state.
- Hidden 3D/PDF viewers pause rendering without discarding camera, zoom or document position; agent and terminal lifecycles stay independent of tab visibility.
- A live-file tab shows preparation immediately, then enables its editor after the original snapshot commits; Retry preserves its captured source.
- Native text chunks share the existing frame scheduler, with final text and state transitions flushed in order.
- Editor and specialized preview code loads at its use boundary; HTML sandbox, comments and rendering behavior stay the same.
- Large JSON responses negotiate gzip; SSE, WebSockets, binary downloads and streaming bodies pass through.

Verification: `web/src/workbench/WorkbenchContext.test.tsx`, `web/src/workbench/CapturedFileActions.test.tsx`, `web/src/workbench/DockWorkspace.test.tsx`, `web/src/workbench/ScopedChatStore.test.tsx`, `web/src/workbench/CapturedFileGate.test.tsx`, `web/src/hooks/useConversationEntryState.test.tsx`, the owning resource/query/viewer suites and `tests/browser_ui/chat/test_workspace_iteration.py`.
Transport and persistence: `tests/server/routes/test_chat_attachments.py`, `tests/server/routes/test_gzip_route.py`, `tests/server/routes/test_workbench_workspaces.py` and artifact-store tests.
Compare the same two/four/twelve-chat scenarios when measuring latency; browser/host timings are not interchangeable with a user's desktop.

### Minimal communication UI

- Incoming peer cards show the actual trusted agent name and source chat, up to three compact lines, and Show full/less.
- The shared user-message footer copies complete text and creates links for the owning conversation, independently of focus.
- Ordinary human quotations of peer transport headers retain their human presentation.
- One task card retains each dispatch's name/instructions and updates status; returned text is a distinct attributed Markdown reply with compact expansion.
- Orchestration uses Workflow, current-chat origin by default, separate Agents/Shells sections and a shared category filter, including settled work.
- Source selection chooses Chat or combined Host/workspace; the selected root constrains host inventory.
- Agent and shell rows open named tabs; historical output never attaches or launches a process.
- Native child input and steering require current runtime capabilities, independently of transcript readability.
- Hidden chats detach streams while retaining state; denied stream slots wait instead of exhausting HTTP/1 connections.
- Orchestration rows open resources in tabs, with no redundant Open button; graph remains available without internal history-coverage or Messages entries.
- Native Codex inputs retain their canonical identity through start/steer and echo; unresolved historical messages are not reclassified by text.
- Peer file references resolve their captured sender target and retain recipient/source ACL and host/runner ownership checks.
- Pane-plus hit targets follow shared density; updating a captured-original menu does not discard or replace a dirty document.

Verification: `tests/browser_ui/chat/test_workspace_iteration.py::test_peer_cards_and_orchestration_keep_attribution_and_minimal_controls`, `web/src/components/blocks/PeerMessage.test.tsx`, `web/src/components/chat/MessageFooter.test.tsx`, `web/src/components/blocks/SubagentActivityMessage.test.tsx`, `web/src/shell/ChatActivityPanel.test.tsx` and `web/src/workbench/DockWorkspace.test.tsx`.
Attribution and file boundaries: `tests/server/integration/test_session_orchestration.py`, `tests/server/routes/test_chat_attachments.py`, `tests/harnesses/codex_native/forwarder/test_user_messages.py` and `tests/inner/test_codex_native_executor.py`.
